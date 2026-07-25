// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';

import { ImChannelSettingsCard } from '../ImChannelSettingsCard';

function Harness() {
  const [expanded, setExpanded] = useState(false);
  return (
    <ImChannelSettingsCard
      id="channel-test"
      title="Feishu Bot"
      description="Personal channel"
      status={<span>Connected</span>}
      routeSummary="Claude Code · Opus"
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <button type="button">Edit Channel</button>
    </ImChannelSettingsCard>
  );
}

describe('ImChannelSettingsCard', () => {
  afterEach(() => cleanup());

  it('keeps the compact summary visible and mounts the editor only when expanded', async () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: /Feishu Bot/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Claude Code · Opus')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Channel' })).toBeNull();

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: 'Edit Channel' })).toBeTruthy();
    });
  });
});
