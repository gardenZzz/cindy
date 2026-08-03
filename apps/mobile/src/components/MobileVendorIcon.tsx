import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useTheme } from '@/theme';

import { MobileAgentMark } from './MobileAgentMark';
import type { AgentKind } from '@cindy/maker-shared';
import { toMakerAgentKind } from '@/session/sessionAgentSwitch';

interface MobileVendorIconProps {
  color?: string;
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | 'cursor' | 'pi' | string;
}

function vendorAccessibilityLabel(vendor: string): string {
  if (vendor === 'codex') return 'Codex';
  if (vendor === 'cursor') return 'Cursor';
  if (vendor === 'pi') return 'Pi';
  return 'Claude Code';
}

function vendorToAgentKind(vendor: string): AgentKind {
  return toMakerAgentKind(vendor === 'claude-code' ? 'cc' : vendor);
}

export function MobileVendorIcon({ color: colorOverride, running = false, size = 12, vendor }: MobileVendorIconProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  const color = colorOverride ?? (running ? colors.statusAccent : colors.textTertiary);

  useEffect(() => {
    opacity.stopAnimation();
    if (!running) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.3);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.3,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, running]);

  return (
    <Animated.View
      accessible
      accessibilityLabel={vendorAccessibilityLabel(vendor)}
      accessibilityRole="image"
      style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}
    >
      <MobileAgentMark
        agentKind={vendorToAgentKind(vendor)}
        color={color}
        size={size}
      />
    </Animated.View>
  );
}
