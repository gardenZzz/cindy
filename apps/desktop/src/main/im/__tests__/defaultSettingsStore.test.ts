import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scopeMocks = vi.hoisted(() => ({
  owner: 'cloud-a',
  join: null as unknown as (...parts: string[]) => string,
  claimLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
  },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    scopeMocks.join('/tmp/xdt-maker-test', 'owners', scopeMocks.owner, ...parts),
  claimLegacyImPath: scopeMocks.claimLegacy,
}));

import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings.js';
import {
  __testing,
  readImDefaultSettings,
  readImDefaultSettingsState,
  resetImDefaultSettings,
  resetImDefaultSettingsChannel,
  writeImDefaultSettingsPatch,
} from '../defaultSettingsStore';

const settingsDir = '/tmp/xdt-maker-test';
const settingsFile = () =>
  path.join(settingsDir, 'owners', scopeMocks.owner, 'im-default-settings.json');

describe('im default settings store', () => {
  beforeEach(() => {
    scopeMocks.join = path.join;
    scopeMocks.owner = 'cloud-a';
    scopeMocks.claimLegacy.mockReset();
    fs.mkdirSync(settingsDir, { recursive: true });
    resetImDefaultSettings();
  });

  afterEach(() => {
    resetImDefaultSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('migrates legacy single-slot overrides after override defaults are merged', () => {
    const normalized = __testing.normalize({
      ...IM_DEFAULT_SETTINGS,
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });

    expect(normalized.agents.codex).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });
    expect(normalized.agents['claude-code']).toEqual(IM_DEFAULT_SETTINGS.agents['claude-code']);
  });

  it('persists only the changed agent override so untouched agents keep inheriting future defaults', () => {
    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toEqual({
      schemaVersion: 2,
      global: {
        agents: {
          codex: {
            providerId: 'openai',
            model: 'gpt-5.5',
            effort: 'high',
          },
        },
      },
    });
  });

  it('preserves existing agent overrides when another agent is updated', () => {
    writeImDefaultSettingsPatch({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'xhigh',
        },
      },
    });

    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toEqual({
      schemaVersion: 2,
      global: {
        agents: {
          'claude-code': {
            providerId: 'anthropic',
            model: 'claude-sonnet-4-8',
            effort: 'xhigh',
          },
          codex: {
            providerId: 'openai',
            model: 'gpt-5.5',
            effort: 'high',
          },
        },
      },
    });
  });

  it('keeps local and cloud default settings in separate owner files', () => {
    writeImDefaultSettingsPatch({ agentKind: 'codex' });

    scopeMocks.owner = 'local-v1';
    expect(readImDefaultSettings()).toEqual(IM_DEFAULT_SETTINGS);
    writeImDefaultSettingsPatch({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'high',
        },
      },
    });

    scopeMocks.owner = 'cloud-a';
    expect(readImDefaultSettings().agentKind).toBe('codex');
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))).toEqual({
      schemaVersion: 2,
      global: { agentKind: 'codex' },
    });
  });

  it('migrates a legacy global override into independent channel routes', () => {
    const migrated = __testing.normalizeDocument({
      ...IM_DEFAULT_SETTINGS,
      agentKind: 'codex',
      agents: {
        ...IM_DEFAULT_SETTINGS.agents,
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(migrated.global.agentKind).toBe('codex');
    expect(migrated.channels.feishu).toEqual(migrated.global);
    expect(migrated.channels.discord).toEqual(migrated.global);
    expect(migrated.channels.slack).toEqual(migrated.global);
  });

  it('writes and resets one channel without changing another channel', () => {
    writeImDefaultSettingsPatch({ agentKind: 'codex' }, 'feishu');
    writeImDefaultSettingsPatch(
      {
        agents: {
          'claude-code': {
            providerId: 'anthropic',
            model: 'claude-sonnet-4-8',
            effort: 'high',
          },
        },
      },
      'discord',
    );

    expect(readImDefaultSettings('feishu').agentKind).toBe('codex');
    expect(readImDefaultSettings('discord').agentKind).toBe('claude-code');
    expect(readImDefaultSettings('discord').agents['claude-code'].model).toBe('claude-sonnet-4-8');

    resetImDefaultSettingsChannel('feishu');

    expect(readImDefaultSettingsState('feishu').isCustomized).toBe(false);
    expect(readImDefaultSettings('feishu')).toEqual(IM_DEFAULT_SETTINGS);
    expect(readImDefaultSettings('discord').agents['claude-code'].model).toBe('claude-sonnet-4-8');
  });
});
