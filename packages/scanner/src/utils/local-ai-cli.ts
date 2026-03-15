import { spawn } from 'child_process';
import { trackAiCliCall } from './claude-usage.js';

export type LocalAiProvider = 'claude' | 'openai';

export interface LocalAiPromptOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  usageContext?: string;
  logContext?: string;
}

export interface LocalAiPromptResult {
  ok: boolean;
  provider: LocalAiProvider;
  stdout: string;
  binary?: string;
  errors: string[];
  disabledReason?: string;
}

const CLAUDE_CANDIDATES = [
  'claude',
  'claude.cmd',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
];

function getProviderFromEnv(): LocalAiProvider {
  return (process.env.LOCAL_AI_PROVIDER || 'claude').toLowerCase() === 'openai'
    ? 'openai'
    : 'claude';
}

export function getLocalAiProvider(): LocalAiProvider {
  return getProviderFromEnv();
}

export function getLocalAiProviderLabel(provider = getProviderFromEnv()): string {
  return provider === 'openai' ? 'OpenAI local CLI' : 'Claude CLI';
}

export function getLocalAiDisabledReason(provider = getProviderFromEnv()): string | null {
  if (provider !== 'openai') return null;
  if (process.env.LOCAL_AI_BINARY?.trim()) return null;
  return [
    'LOCAL_AI_PROVIDER=openai requires LOCAL_AI_BINARY to point to a headless CLI.',
    'The installed ChatGPT/Codex desktop apps on this machine are interactive or blocked for spawn,',
    'so they are not safe for scanner automation.'
  ].join(' ');
}

export function getLocalAiCandidates(provider = getProviderFromEnv()): string[] {
  const explicitBinary = process.env.LOCAL_AI_BINARY?.trim();
  if (explicitBinary) return [explicitBinary];

  if (provider === 'claude') {
    if (process.platform === 'win32') {
      return CLAUDE_CANDIDATES.filter(candidate => !candidate.startsWith('/'));
    }
    return CLAUDE_CANDIDATES.filter(candidate => !candidate.includes(':\\'));
  }

  // OpenAI local mode is intentionally opt-in via LOCAL_AI_BINARY so we never
  // auto-launch a GUI desktop app or hit WindowsApps spawn restrictions.
  return [];
}

function formatExecError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown error';
  const err = error as {
    message?: string;
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };
  const parts = [
    err.code ? `code=${String(err.code)}` : '',
    err.signal ? `signal=${err.signal}` : '',
    err.killed ? 'killed=true' : '',
    err.message ? `msg=${err.message}` : ''
  ].filter(Boolean);
  return parts.join(' ');
}

async function runBinary(
  binary: string,
  prompt: string,
  timeoutMs: number,
  maxBufferBytes: number
): Promise<{ stdout: string }> {
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(binary, ['-p'], {
      shell: process.platform === 'win32' && binary.toLowerCase().endsWith('.cmd'),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject({ code: 'ETIMEDOUT', message: `timeout after ${timeoutMs}ms` }));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += chunk.toString();
      if (stdout.length > maxBufferBytes) {
        child.kill();
        finish(() => reject({ code: 'E2BIG', message: `stdout exceeds ${maxBufferBytes} bytes` }));
      }
    });

    child.stderr.on('data', chunk => {
      if (settled) return;
      stderr += chunk.toString();
      if (stderr.length > maxBufferBytes) {
        child.kill();
        finish(() => reject({ code: 'E2BIG', message: `stderr exceeds ${maxBufferBytes} bytes` }));
      }
    });

    child.on('error', error => {
      finish(() => reject(error));
    });

    child.on('close', code => {
      if (code === 0) {
        finish(() => resolve({ stdout }));
        return;
      }
      const message = stderr.trim() || `process exited with code ${String(code)}`;
      finish(() => reject({ code, message }));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function runLocalAiPrompt(
  prompt: string,
  options: LocalAiPromptOptions = {}
): Promise<LocalAiPromptResult> {
  const provider = getProviderFromEnv();
  const disabledReason = getLocalAiDisabledReason(provider);
  if (disabledReason) {
    if (options.logContext) {
      console.warn(`[ai-cli:${provider}] ${options.logContext} skipped: ${disabledReason}`);
    }
    return {
      ok: false,
      provider,
      stdout: '',
      errors: [disabledReason],
      disabledReason
    };
  }

  const candidates = getLocalAiCandidates(provider);
  if (candidates.length === 0) {
    const message = `No configured ${getLocalAiProviderLabel(provider)} binary candidates`;
    if (options.logContext) {
      console.warn(`[ai-cli:${provider}] ${options.logContext} skipped: ${message}`);
    }
    return {
      ok: false,
      provider,
      stdout: '',
      errors: [message]
    };
  }

  trackAiCliCall(options.usageContext || options.logContext || 'local-ai');
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
  const errors: string[] = [];

  for (const binary of candidates) {
    try {
      const { stdout } = await runBinary(binary, prompt, timeoutMs, maxBufferBytes);
      return {
        ok: true,
        provider,
        stdout: stdout.trim(),
        binary,
        errors
      };
    } catch (error) {
      errors.push(`${binary}: ${formatExecError(error)}`);
    }
  }

  if (options.logContext) {
    console.warn(
      `[ai-cli:${provider}] ${options.logContext} failed: ${errors.slice(-3).join(' | ')}`
    );
  }

  return {
    ok: false,
    provider,
    stdout: '',
    errors
  };
}
