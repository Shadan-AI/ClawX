import { describe, expect, it } from 'vitest';
import { isClaudePromptReadyChunk, maskClaudeBannerInChunk } from '@/pages/Chat/NativeCliTerminal';

describe('maskClaudeBannerInChunk', () => {
  it('masks full Claude welcome box chunks, including rows without direct signatures', () => {
    const chunk = [
      '╭─── Claude Code v2.1.162 ─────────────────────────╮',
      '│                Welcome back!               │ Tips for getting started │',
      '│                                            │ Run /init to create a CLAUDE.md file │',
      '│   ~\\.openclaw\\workspace-bot-mpz3pwnmvwkr   │',
      '╰────────────────────────────────────────────╯',
    ].join('\r\n');

    const masked = maskClaudeBannerInChunk(chunk);

    expect(masked.length).toBe(chunk.length);
    expect(masked).not.toContain('Welcome back!');
    expect(masked).not.toContain('Tips for getting started');
    expect(masked).not.toContain('workspace-bot');
  });

  it('masks Claude VS Code onboarding prompt chunks without deleting ANSI bytes', () => {
    const chunk = [
      '\x1b[?2026h  ✻ Welcome to Claude Code for VS Code\x1b[K',
      '  install the extension to enter longer lines in your input\x1b[K',
      ' Press Enter to continue\x1b[K\x1b[69C',
    ].join('\r\n');

    const masked = maskClaudeBannerInChunk(chunk);

    expect(masked.length).toBe(chunk.length);
    expect(masked).toContain('\x1b[?2026h');
    expect(masked).toContain('\x1b[K\x1b[69C');
    expect(masked).not.toContain('Welcome to Claude Code for VS Code');
    expect(masked).not.toContain('install the extension');
    expect(masked).not.toContain('Press Enter to continue');
  });

  it('masks Claude release-note footer rows', () => {
    const chunk = ' ▎ Opus 4.8 is now available! · /model to switch\r\nnormal output';

    const masked = maskClaudeBannerInChunk(chunk);

    expect(masked.length).toBe(chunk.length);
    expect(masked).not.toContain('Opus 4.8 is now available');
    expect(masked).toContain('normal output');
  });
});

describe('isClaudePromptReadyChunk', () => {
  const prompt = String.fromCodePoint(0x276f);

  it('detects Claude empty prompt rows after ANSI controls are stripped', () => {
    expect(isClaudePromptReadyChunk(`\x1b[9;3H${prompt} \x1b[30m\x1b[47m \x1b[m`)).toBe(true);
  });

  it('does not treat the echoed user prompt as ready', () => {
    expect(isClaudePromptReadyChunk(`${prompt} explain this bug\r\n`)).toBe(false);
  });
});
