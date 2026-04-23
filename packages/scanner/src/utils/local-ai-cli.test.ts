import { afterEach, describe, expect, it } from 'vitest';
import {
  getLocalAiCandidates,
  getLocalAiDisabledReason,
  getLocalAiProvider
} from './local-ai-cli.js';

const ORIGINAL_PROVIDER = process.env.LOCAL_AI_PROVIDER;
const ORIGINAL_BINARY = process.env.LOCAL_AI_BINARY;

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) {
    delete process.env.LOCAL_AI_PROVIDER;
  } else {
    process.env.LOCAL_AI_PROVIDER = ORIGINAL_PROVIDER;
  }

  if (ORIGINAL_BINARY === undefined) {
    delete process.env.LOCAL_AI_BINARY;
  } else {
    process.env.LOCAL_AI_BINARY = ORIGINAL_BINARY;
  }
});

describe('local AI CLI provider selection', () => {
  it('defaults to claude mode', () => {
    delete process.env.LOCAL_AI_PROVIDER;
    delete process.env.LOCAL_AI_BINARY;

    expect(getLocalAiProvider()).toBe('claude');
    expect(getLocalAiDisabledReason()).toBeNull();
    expect(getLocalAiCandidates().length).toBeGreaterThan(0);
  });

  it('uses Windows-safe Claude candidates on win32', () => {
    delete process.env.LOCAL_AI_PROVIDER;
    delete process.env.LOCAL_AI_BINARY;

    if (process.platform !== 'win32') {
      expect(getLocalAiCandidates()).not.toContain('claude.cmd');
      return;
    }

    const candidates = getLocalAiCandidates();
    expect(candidates).toContain('claude.cmd');
    expect(candidates).toContain('C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd');
    expect(candidates).not.toContain('claude');
    expect(candidates).not.toContain('C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude');
  });

  it('refuses openai mode without an explicit headless binary', () => {
    process.env.LOCAL_AI_PROVIDER = 'openai';
    delete process.env.LOCAL_AI_BINARY;

    expect(getLocalAiProvider()).toBe('openai');
    expect(getLocalAiDisabledReason()).toContain('LOCAL_AI_BINARY');
    expect(getLocalAiCandidates()).toEqual([]);
  });

  it('accepts openai mode when an explicit binary is configured', () => {
    process.env.LOCAL_AI_PROVIDER = 'openai';
    process.env.LOCAL_AI_BINARY = 'C:\\tools\\openai-cli.exe';

    expect(getLocalAiDisabledReason()).toBeNull();
    expect(getLocalAiCandidates()).toEqual(['C:\\tools\\openai-cli.exe']);
  });
});
