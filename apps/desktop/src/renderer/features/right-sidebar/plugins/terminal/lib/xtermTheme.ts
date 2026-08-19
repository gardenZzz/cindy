/**
 * 把当前 Cindy 主题解析成 xterm `ITheme`。
 *
 * xterm 只吃 hex / rgb(a)，不吃 `var(--token)`，所以必须先从 :root 解析出计算色。
 * 画布 / 正文 / 光标 / 选区 / 红绿黄蓝走已有语义 token；magenta / cyan 没有对应槽位，
 * 故意不写，留给 xterm tango 默认。
 */
import type { ITheme } from '@xterm/xterm';

/** Default Light 回退（DESIGN.md §2 / colors.ts），仅 CSS 变量读不到时用。 */
const FALLBACK = {
  background: '#f8f8f6',
  foreground: '#262626',
  cursor: '#262626',
  selectionBackground: 'rgba(65, 124, 221, 0.5)',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#22863a',
  yellow: '#F3A115',
  blue: '#2563eb',
  brightBlack: '#737373',
  brightRed: '#991b1b',
  brightYellow: '#EA6B17',
  brightBlue: '#417CDD',
  brightWhite: '#ffffff',
} as const;

export type CssColorReader = (token: string) => string;

function isUsableCssColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v !== '' &&
    v !== 'canvastext' &&
    v !== 'transparent' &&
    v !== 'inherit' &&
    v !== 'rgba(0, 0, 0, 0)'
  );
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function parseRgbChannels(css: string): { r: number; g: number; b: number; a: number } | null {
  const rgb = css.match(
    /rgba?\(\s*([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*,\s*|\s+)([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i,
  );
  if (rgb) {
    const aRaw = rgb[4];
    const a = aRaw
      ? aRaw.endsWith('%')
        ? Number.parseFloat(aRaw) / 100
        : Number.parseFloat(aRaw)
      : 1;
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a };
  }

  const hex = css.trim().match(/^#([\da-f]{3,8})$/i);
  if (!hex) return null;
  const raw = hex[1];
  if (raw.length === 3 || raw.length === 4) {
    return {
      r: parseInt(raw[0] + raw[0], 16),
      g: parseInt(raw[1] + raw[1], 16),
      b: parseInt(raw[2] + raw[2], 16),
      a: raw.length === 4 ? parseInt(raw[3] + raw[3], 16) / 255 : 1,
    };
  }
  if (raw.length === 6 || raw.length === 8) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
      a: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** xterm 的 css.toColor 只稳吃 `#rgb` / `#rrggbb` / 逗号 `rgb(a)`。 */
function toXtermColor(css: string): string | null {
  const channels = parseRgbChannels(css);
  if (!channels) return isUsableCssColor(css) ? css.trim() : null;
  const { r, g, b, a } = channels;
  if (a < 1) return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
  return `#${hex2(Math.round(r))}${hex2(Math.round(g))}${hex2(Math.round(b))}`;
}

export function isDarkCanvas(cssColor: string): boolean {
  const channels = parseRgbChannels(cssColor);
  if (!channels) return false;
  const { r, g, b } = channels;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
}

export function readCssVarColor(token: string): string {
  if (typeof document === 'undefined') return '';
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.documentElement.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value.trim();
}

export function buildXtermTheme(readColor: CssColorReader = readCssVarColor): ITheme {
  const color = (token: string, fallback: string): string => {
    const normalized = toXtermColor(readColor(token));
    return normalized ?? fallback;
  };

  const background = color('--surface', FALLBACK.background);
  const foreground = color('--text-primary', FALLBACK.foreground);
  const dark = isDarkCanvas(background);

  return {
    background,
    foreground,
    cursor: color('--caret-accent', FALLBACK.cursor),
    cursorAccent: background,
    selectionBackground: color('--text-selection-bg', FALLBACK.selectionBackground),
    black: dark
      ? color('--border-default', '#3c3c3a')
      : color('--text-primary-emphasis', FALLBACK.black),
    red: color('--error-fg', FALLBACK.red),
    green: color('--diff-add-fg', FALLBACK.green),
    yellow: color('--warning-fg', FALLBACK.yellow),
    blue: color('--msg-link', FALLBACK.blue),
    white: dark
      ? color('--text-primary', FALLBACK.foreground)
      : color('--text-tertiary', '#a3a3a3'),
    brightBlack: color('--text-secondary', FALLBACK.brightBlack),
    brightRed: color('--error-fg-strong', FALLBACK.brightRed),
    brightGreen: color('--diff-add-fg', FALLBACK.green),
    brightYellow: color('--warning-accent', FALLBACK.brightYellow),
    brightBlue: color('--focus-ring', FALLBACK.brightBlue),
    brightWhite: dark
      ? color('--text-primary-on-dark', FALLBACK.brightWhite)
      : color('--surface-on-card', FALLBACK.brightWhite),
  };
}
