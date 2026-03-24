import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScannerLock } from './scanner-lock.js';

describe('ScannerLock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('acquires and releases a lock file for the current process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scanner-lock-'));
    tempDirs.push(dir);
    const lock = new ScannerLock(join(dir, 'scanner.lock'));

    lock.acquire('test-run');
    expect(lock.isHeld()).toBe(true);

    lock.release();
    expect(lock.isHeld()).toBe(false);
  });

  it('reclaims stale lock files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scanner-lock-'));
    tempDirs.push(dir);
    const lockPath = join(dir, 'scanner.lock');
    const lock = new ScannerLock(lockPath);

    writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      owner: 'stale',
      acquiredAt: new Date().toISOString()
    }));

    lock.acquire('fresh-run');
    expect(lock.isHeld()).toBe(true);
  });
});
