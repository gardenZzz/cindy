/**
 * MobileAgentMark —— Claude Code / Codex CLI / Cursor 的 Agent 身份 mark。
 * 不用于 Anthropic / OpenAI provider 或模型品牌；后两者由 MobileProviderMark 负责。
 */
import Svg, { G, Path } from 'react-native-svg';
import { StyleSheet } from 'react-native';

import { iconSize, iconStroke } from '@/theme';

import {
  CLAUDE_AGENT_PATH,
  CODEX_AGENT_FLOWER_PATH,
  CODEX_AGENT_PROMPT_PATH,
  CURSOR_AGENT_PATH,
} from './vendorIconPaths';
import type { AgentKind } from '@cindy/maker-shared';

export interface MobileAgentMarkProps {
  agentKind: AgentKind;
  color: string;
  size?: number;
}

/** 单色 CLI mark；颜色由宿主的主题 / 状态 token 决定。 */
export function MobileAgentMark({ agentKind, color, size = iconSize.sm }: MobileAgentMarkProps) {
  const codexStrokeWidth = size <= iconSize.sm ? iconStroke.regular : iconStroke.thin;
  return (
    <Svg accessible={false} height={size} viewBox="0 0 24 24" width={size}>
      {agentKind === 'codex' ? (
        <G transform="translate(12 12) scale(1.1) translate(-12 -12)">
          <Path
            d={`${CODEX_AGENT_FLOWER_PATH}z`}
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={codexStrokeWidth}
          />
          <Path
            d={CODEX_AGENT_PROMPT_PATH}
            fill={color}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={StyleSheet.hairlineWidth}
          />
        </G>
      ) : agentKind === 'cursor' ? (
        <Path d={CURSOR_AGENT_PATH} fill={color} />
      ) : (
        <Path clipRule="evenodd" d={CLAUDE_AGENT_PATH} fill={color} fillRule="evenodd" />
      )}
    </Svg>
  );
}
