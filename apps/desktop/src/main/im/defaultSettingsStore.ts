/**
 * IM 默认设置的 main 端持久化源。
 *
 * 每个渠道独立保存新会话路由。文件只保存用户 override；系统默认值来自
 * shared/imDefaultSettings。旧版单槽配置会在首次写入新版结构时按渠道复制一次，
 * 既保留用户原选择，又让之后的渠道修改互不影响。
 */

import path from 'node:path';
import { app } from 'electron';

import {
  IM_DEFAULT_SETTINGS,
  IM_DEFAULT_SETTINGS_CHANNELS,
  type ImDefaultAgentKind,
  type ImDefaultAgentSettings,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
  type ImDefaultSettings,
  isImDefaultAgentKind,
  isImDefaultEffort,
} from '../../shared/imDefaultSettings.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';
import { claimLegacyImPath, ownerScopedImUserDataPath } from './ownerScopedStorage.js';

const log = desktopMakerLogger.child('im-default-settings-store');
const SETTINGS_SCHEMA_VERSION = 2;

interface ImDefaultSettingsDocument {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  global: ImDefaultSettings;
  channels: Record<ImDefaultSettingsChannel, ImDefaultSettings>;
}

const IM_DEFAULT_SETTINGS_DOCUMENT: ImDefaultSettingsDocument = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  global: cloneSettings(IM_DEFAULT_SETTINGS),
  channels: Object.fromEntries(
    IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [channel, cloneSettings(IM_DEFAULT_SETTINGS)]),
  ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
};

function settingsFilePath(): string {
  const scoped = ownerScopedImUserDataPath('im-default-settings.json');
  claimLegacyImPath(path.join(app.getPath('userData'), 'im-default-settings.json'), scoped);
  return scoped;
}

function normalizeSettings(raw: unknown): ImDefaultSettings {
  if (!raw || typeof raw !== 'object') return { ...IM_DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const agentKind = isImDefaultAgentKind(r.agentKind) ? r.agentKind : IM_DEFAULT_SETTINGS.agentKind;
  const rawAgents = isRecord(r.agents) ? r.agents : {};
  const legacySettings = legacyAgentSettings(r);
  return {
    agentKind,
    agents: {
      'claude-code': normalizeAgentSettings(
        'claude-code',
        rawAgentOrLegacy(rawAgents, 'claude-code', agentKind, legacySettings),
      ),
      codex: normalizeAgentSettings(
        'codex',
        rawAgentOrLegacy(rawAgents, 'codex', agentKind, legacySettings),
      ),
    },
  };
}

function normalizeDocument(raw: unknown): ImDefaultSettingsDocument {
  const record = isRecord(raw) ? raw : {};
  const hasLegacyRootSettings =
    'agentKind' in record ||
    'agents' in record ||
    'providerId' in record ||
    'model' in record ||
    'effort' in record;

  // Before schema v2 there was one flat route shared by every IM channel.
  // A legacy file is unambiguous user customization, so seed every channel
  // from it once. The next write serializes a v2 document and ends inheritance.
  if (hasLegacyRootSettings) {
    const legacy = normalizeSettings(record);
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: cloneSettings(legacy),
      channels: Object.fromEntries(
        IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [channel, cloneSettings(legacy)]),
      ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
    };
  }

  const rawChannels = isRecord(record.channels) ? record.channels : {};
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    global: normalizeSettings(record.global),
    channels: Object.fromEntries(
      IM_DEFAULT_SETTINGS_CHANNELS.map((channel) => [
        channel,
        normalizeSettings(rawChannels[channel]),
      ]),
    ) as Record<ImDefaultSettingsChannel, ImDefaultSettings>,
  };
}

function rawAgentOrLegacy(
  rawAgents: Record<string, unknown>,
  target: ImDefaultAgentKind,
  selected: ImDefaultAgentKind,
  legacySettings: Partial<ImDefaultAgentSettings> | null,
): unknown {
  const raw = rawAgents[target];
  if (target !== selected || !legacySettings) return raw ?? null;
  if (!isRecord(raw)) return legacySettings;
  return agentSettingsMatchesDefaults(target, raw) ? legacySettings : raw;
}

function agentSettingsMatchesDefaults(
  agentKind: ImDefaultAgentKind,
  raw: Record<string, unknown>,
): boolean {
  const normalized = normalizeAgentSettings(agentKind, raw);
  return JSON.stringify(normalized) === JSON.stringify(IM_DEFAULT_SETTINGS.agents[agentKind]);
}

function normalizeAgentSettings(
  agentKind: ImDefaultAgentKind,
  raw: unknown,
): ImDefaultAgentSettings {
  const defaults = IM_DEFAULT_SETTINGS.agents[agentKind];
  if (!isRecord(raw)) return { ...defaults };
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : defaults.effort,
  };
}

function legacyAgentSettings(raw: Record<string, unknown>): Partial<ImDefaultAgentSettings> | null {
  if (!('providerId' in raw) && !('model' in raw) && !('effort' in raw)) return null;
  return {
    providerId:
      typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    effort: isImDefaultEffort(raw.effort) ? raw.effort : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const store = createOverrideSettingsFile<ImDefaultSettingsDocument>({
  filePath: settingsFilePath,
  defaults: IM_DEFAULT_SETTINGS_DOCUMENT,
  normalize: normalizeDocument,
  mergeOverrides: ({ next, defaults }) => documentOverrides(next, defaults),
  log,
  label: 'im-default',
});

export function readImDefaultSettings(channel?: ImDefaultSettingsChannel): ImDefaultSettings {
  const document = store.read();
  return cloneSettings(channel ? document.channels[channel] : document.global);
}

export function readImDefaultSettingsState(
  channel?: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const value = readImDefaultSettings(channel);
  const customizedKeys = settingsCustomizedKeys(value, IM_DEFAULT_SETTINGS);
  return {
    value,
    isCustomized: customizedKeys.length > 0,
    defaults: cloneSettings(IM_DEFAULT_SETTINGS),
    customizedKeys,
  };
}

export function writeImDefaultSettingsPatch(
  patch: ImDefaultSettingsPatch,
  channel?: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const document = store.read();
  const current = channel ? document.channels[channel] : document.global;
  const next = mergeSettingsPatch(current, patch);
  if (channel) {
    store.writePatch({
      channels: {
        ...document.channels,
        [channel]: next,
      },
    });
  } else {
    store.writePatch({ global: next });
  }
  log.info('im default settings written', { channel: channel ?? 'global', patch });
  return readImDefaultSettingsState(channel);
}

export function resetImDefaultSettings(): ImDefaultSettings {
  return store.reset().global;
}

export function resetImDefaultSettingsChannel(
  channel: ImDefaultSettingsChannel,
): OverrideSettingsState<ImDefaultSettings> {
  const document = store.read();
  store.writePatch({
    channels: {
      ...document.channels,
      [channel]: cloneSettings(IM_DEFAULT_SETTINGS),
    },
  });
  log.info('im default settings reset', { channel });
  return readImDefaultSettingsState(channel);
}

export const __testing = {
  normalize: normalizeSettings,
  normalizeDocument,
};

function mergeSettingsPatch(
  current: ImDefaultSettings,
  patch: ImDefaultSettingsPatch,
): ImDefaultSettings {
  return normalizeSettings({
    ...current,
    ...patch,
    agents: patch.agents ? { ...current.agents, ...patch.agents } : current.agents,
  });
}

function documentOverrides(
  next: ImDefaultSettingsDocument,
  defaults: ImDefaultSettingsDocument,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = { schemaVersion: SETTINGS_SCHEMA_VERSION };
  const global = settingsOverrides(next.global, defaults.global);
  if (Object.keys(global).length > 0) overrides.global = global;

  const channels: Partial<Record<ImDefaultSettingsChannel, Record<string, unknown>>> = {};
  for (const channel of IM_DEFAULT_SETTINGS_CHANNELS) {
    const channelOverrides = settingsOverrides(next.channels[channel], defaults.channels[channel]);
    if (Object.keys(channelOverrides).length > 0) channels[channel] = channelOverrides;
  }
  if (Object.keys(channels).length > 0) overrides.channels = channels;
  return overrides;
}

function settingsOverrides(
  value: ImDefaultSettings,
  defaults: ImDefaultSettings,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (value.agentKind !== defaults.agentKind) overrides.agentKind = value.agentKind;
  const agents: Partial<Record<ImDefaultAgentKind, ImDefaultAgentSettings>> = {};
  for (const agentKind of ['claude-code', 'codex'] as const) {
    if (!agentSettingsEqual(value.agents[agentKind], defaults.agents[agentKind])) {
      agents[agentKind] = value.agents[agentKind];
    }
  }
  if (Object.keys(agents).length > 0) overrides.agents = agents;
  return overrides;
}

function settingsCustomizedKeys(value: ImDefaultSettings, defaults: ImDefaultSettings): string[] {
  const keys: string[] = [];
  if (value.agentKind !== defaults.agentKind) keys.push('agentKind');
  for (const agentKind of ['claude-code', 'codex'] as const) {
    if (!agentSettingsEqual(value.agents[agentKind], defaults.agents[agentKind])) {
      keys.push(`agents.${agentKind}`);
    }
  }
  return keys;
}

function agentSettingsEqual(a: ImDefaultAgentSettings, b: ImDefaultAgentSettings): boolean {
  return a.providerId === b.providerId && a.model === b.model && a.effort === b.effort;
}

function cloneSettings(settings: ImDefaultSettings): ImDefaultSettings {
  return {
    agentKind: settings.agentKind,
    agents: {
      'claude-code': { ...settings.agents['claude-code'] },
      codex: { ...settings.agents.codex },
    },
  };
}
