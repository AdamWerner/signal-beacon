import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

interface LockPayload {
  pid: number;
  owner: string;
  acquiredAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ScannerLock {
  private held = false;

  constructor(private lockPath: string) {}

  isHeld(): boolean {
    return this.held;
  }

  acquire(owner: string): void {
    if (this.held) return;
    mkdirSync(dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        const payload: LockPayload = {
          pid: process.pid,
          owner,
          acquiredAt: new Date().toISOString()
        };
        writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
        closeSync(fd);
        this.held = true;
        return;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }

        const current = this.readPayload();
        if (current && current.pid === process.pid) {
          this.held = true;
          return;
        }

        if (!current || !isProcessAlive(current.pid)) {
          this.forceRelease();
          continue;
        }

        throw new Error(
          `Scanner lock held by pid ${current.pid} (${current.owner}) since ${current.acquiredAt}`
        );
      }
    }

    throw new Error(`Failed to acquire scanner lock at ${this.lockPath}`);
  }

  release(): void {
    if (!this.held && !existsSync(this.lockPath)) return;
    const current = this.readPayload();
    if (!current || current.pid === process.pid) {
      this.forceRelease();
    }
    this.held = false;
  }

  private readPayload(): LockPayload | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      return JSON.parse(raw) as LockPayload;
    } catch {
      return null;
    }
  }

  private forceRelease(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Ignore stale/unreadable cleanup errors.
    }
  }
}
