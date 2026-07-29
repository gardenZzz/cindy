/**
 * CursorMark —— Cursor 产品身份 mark（简笔画光标箭头），currentColor 单色。
 * T2 最小回路用；后续可换成官方资产。
 */

interface CursorMarkProps {
  size?: number;
  className?: string;
}

export function CursorMark({ size = 14, className }: CursorMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M5.5 3.2 18.8 12l-6.1 1.4 3.4 6.9-2.4 1.2-3.5-7.1L5.5 20.5V3.2z"
      />
    </svg>
  );
}
