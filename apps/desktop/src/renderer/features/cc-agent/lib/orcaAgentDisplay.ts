import type { AgentKind } from '@cindy/maker-core';
export type OrcaDisplayAgentKind = AgentKind;
export type OrcaDisplayVendor = 'cc' | 'codex' | 'cursor' | 'pi';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'cursor') return 'cursor';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'cursor') return 'Cursor';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'cursor') return 'cursor';
  if (agentKind === 'pi') return 'pi';
  return 'cc';
}
