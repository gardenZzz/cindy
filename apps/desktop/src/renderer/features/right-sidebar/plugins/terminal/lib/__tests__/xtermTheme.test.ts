import { describe, expect, it } from 'vitest';

import { buildXtermTheme, isDarkCanvas } from '../xtermTheme';

const CINDY_LIGHT: Record<string, string> = {
  '--surface': '#F2F2ED',
  '--text-primary': '#1A1A1A',
  '--text-primary-emphasis': '#0C0C0C',
  '--text-primary-on-dark': '#FFFFFF',
  '--text-secondary': '#888883',
  '--text-tertiary': '#6B6B67',
  '--border-default': '#E4E4DF',
  '--surface-on-card': '#FFFFFF',
  '--caret-accent': '#417CDD',
  '--text-selection-bg': 'rgba(65, 124, 221, 0.5)',
  '--error-fg': '#dc2626',
  '--error-fg-strong': '#991b1b',
  '--diff-add-fg': '#22863a',
  '--warning-fg': '#F3A115',
  '--warning-accent': '#EA6B17',
  '--msg-link': '#1D4ED8',
  '--focus-ring': '#417CDD',
};

const CINDY_DARK: Record<string, string> = {
  ...CINDY_LIGHT,
  '--surface': '#181818',
  '--text-primary': '#D4D4D4',
  '--text-primary-emphasis': '#FFFFFF',
  '--text-secondary': '#6F6F6F',
  '--text-tertiary': '#C1C1C1',
  '--border-default': '#313131',
  '--surface-on-card': '#181818',
  '--diff-add-fg': '#7ee787',
  '--error-fg': '#f87171',
  '--error-fg-strong': '#fca5a5',
};

function reader(map: Record<string, string>) {
  return (token: string) => map[token] ?? '';
}

describe('buildXtermTheme', () => {
  it('maps Cindy light tokens onto the xterm canvas and ANSI slots', () => {
    const theme = buildXtermTheme(reader(CINDY_LIGHT));
    expect(theme.background).toBe('#f2f2ed');
    expect(theme.foreground).toBe('#1a1a1a');
    expect(theme.cursor).toBe('#417cdd');
    expect(theme.cursorAccent).toBe('#f2f2ed');
    expect(theme.selectionBackground).toBe('rgba(65, 124, 221, 0.5)');
    expect(theme.black).toBe('#0c0c0c');
    expect(theme.red).toBe('#dc2626');
    expect(theme.green).toBe('#22863a');
    expect(theme.yellow).toBe('#f3a115');
    expect(theme.blue).toBe('#1d4ed8');
    expect(theme.white).toBe('#6b6b67');
    expect(theme.brightBlue).toBe('#417cdd');
    expect(theme.brightWhite).toBe('#ffffff');
    expect(theme.magenta).toBeUndefined();
    expect(theme.cyan).toBeUndefined();
  });

  it('flips ANSI black/white for a dark canvas so ls --color stays readable', () => {
    const theme = buildXtermTheme(reader(CINDY_DARK));
    expect(theme.background).toBe('#181818');
    expect(theme.foreground).toBe('#d4d4d4');
    expect(theme.black).toBe('#313131');
    expect(theme.white).toBe('#d4d4d4');
    expect(theme.brightWhite).toBe('#ffffff');
    expect(theme.green).toBe('#7ee787');
  });

  it('falls back to Default Light when CSS variables are missing', () => {
    const theme = buildXtermTheme(() => '');
    expect(theme.background).toBe('#f8f8f6');
    expect(theme.foreground).toBe('#262626');
    expect(theme.red).toBe('#dc2626');
  });

  it('normalizes modern space-separated rgb() so xterm can parse it', () => {
    const theme = buildXtermTheme((token) =>
      token === '--surface' ? 'rgb(248 248 246)' : '',
    );
    expect(theme.background).toBe('#f8f8f6');
  });
});

describe('isDarkCanvas', () => {
  it('treats Cindy dark surface as dark and light surface as light', () => {
    expect(isDarkCanvas('#181818')).toBe(true);
    expect(isDarkCanvas('#F2F2ED')).toBe(false);
    expect(isDarkCanvas('rgb(31, 31, 30)')).toBe(true);
  });
});
