import type { RemoteSession } from './types';
import type { AgentKind } from '@cindy/maker-shared';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): AgentKind {
  if (session.agentKind === 'codex') return 'codex';
  if (session.agentKind === 'cursor') return 'cursor';
  if (session.agentKind === 'pi') return 'pi';
  return 'claude-code';
}
