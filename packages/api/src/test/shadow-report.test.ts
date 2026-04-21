import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'shadow-report.js');
const tempDirs: string[] = [];

interface ShadowRowSpec {
  id: string;
  origin: string;
  confidence: number;
  tpFirst: number;
  maxFavorable: number;
  maxAdverse: number;
  netMaxFavorable: number;
}

function createFixture(shadowRows: ShadowRowSpec[] = [
  {
    id: 'shadow-1',
    origin: 'hybrid',
    confidence: 72,
    tpFirst: 1,
    maxFavorable: 2.5,
    maxAdverse: -0.8,
    netMaxFavorable: 0.9
  },
  {
    id: 'shadow-2',
    origin: 'hybrid',
    confidence: 72,
    tpFirst: 0,
    maxFavorable: 1.5,
    maxAdverse: -0.4,
    netMaxFavorable: 0.1
  }
]) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-report-'));
  tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, 'fixture.db');
  const heartbeatPath = path.join(tempDir, 'scanner-heartbeat.txt');
  const logPath = path.join(tempDir, 'scan-log.txt');
  const analysisDir = path.join(tempDir, 'analysis');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY,
      timestamp TEXT,
      signal_origin TEXT,
      push_gate_outcome TEXT,
      matched_asset_id TEXT,
      matched_asset_name TEXT
    );

    CREATE TABLE push_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL UNIQUE,
      asset_id TEXT NOT NULL,
      push_timestamp TEXT,
      signal_origin TEXT,
      confidence INTEGER,
      max_favorable_pct REAL,
      max_adverse_pct REAL,
      net_max_favorable_pct REAL,
      tp_first INTEGER DEFAULT 0,
      evaluated_at TEXT,
      is_shadow INTEGER NOT NULL DEFAULT 0,
      shadow_push_at TEXT,
      shadow_bypassed_gates TEXT,
      entry_anchor_ts TEXT
    );
  `);

  const signalInsert = db.prepare(`
    INSERT INTO signals (id, timestamp, signal_origin, push_gate_outcome, matched_asset_id, matched_asset_name)
    VALUES (?, datetime('now', '-2 days'), ?, 'shadow_push: all gates passed, HA suppressed', 'oil-equinor', 'Equinor')
  `);
  const outcomeInsert = db.prepare(`
    INSERT INTO push_outcomes (
      signal_id, asset_id, push_timestamp, signal_origin, confidence,
      max_favorable_pct, max_adverse_pct, net_max_favorable_pct, tp_first,
      evaluated_at, is_shadow, shadow_push_at, shadow_bypassed_gates, entry_anchor_ts
    )
    VALUES (?, 'oil-equinor', datetime('now', '-2 days'), ?, ?, ?, ?, ?, ?, datetime('now', '-1 days'), 1, datetime('now', '-2 days'), '["market_closed"]', datetime('now', '-2 days'))
  `);

  for (const row of shadowRows) {
    signalInsert.run(row.id, row.origin);
    outcomeInsert.run(
      row.id,
      row.origin,
      row.confidence,
      row.maxFavorable,
      row.maxAdverse,
      row.netMaxFavorable,
      row.tpFirst
    );
  }

  db.exec(`
    INSERT INTO signals (id, timestamp, signal_origin, push_gate_outcome, matched_asset_id, matched_asset_name)
    VALUES ('live-1', datetime('now', '-2 days'), 'polymarket', 'pushed: all gates passed', 'oil-equinor', 'Equinor');

    INSERT INTO push_outcomes (
      signal_id, asset_id, push_timestamp, signal_origin, confidence,
      max_favorable_pct, max_adverse_pct, net_max_favorable_pct, tp_first,
      evaluated_at, is_shadow, shadow_push_at, shadow_bypassed_gates, entry_anchor_ts
    )
    VALUES ('live-1', 'oil-equinor', datetime('now', '-2 days'), 'polymarket', 80, 1.0, -0.3, -0.2, 1, datetime('now', '-1 days'), 0, NULL, NULL, datetime('now', '-2 days'));
  `);
  db.close();

  fs.writeFileSync(heartbeatPath, new Date().toISOString());
  fs.writeFileSync(logPath, '[cycle 101] ok\n[cycle 102] timeout waiting for scanner\n');

  return { dbPath, heartbeatPath, logPath, analysisDir };
}

function runShadowReport(args: string[], env: Record<string, string>) {
  return execFileSync('node', [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    encoding: 'utf8'
  });
}

describe('shadow-report script', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reports shadow row counts and Wilson statistics from a fixture DB', () => {
    const fixture = createFixture();
    const output = runShadowReport([], {
      POLYSIGNAL_DB_PATH: fixture.dbPath,
      POLYSIGNAL_HEARTBEAT_PATH: fixture.heartbeatPath,
      POLYSIGNAL_SCAN_LOG_PATH: fixture.logPath,
      POLYSIGNAL_ANALYSIS_DIR: fixture.analysisDir
    });

    expect(output).toContain('shadow_rows_created: 2');
    expect(output).toContain('shadow_rows_evaluated: 2');
    expect(output).toMatch(/hybrid\s+\|\s+70-80\s+\|\s+2\s+\|\s+1\s+\|\s+50\.0%\s+\|\s+9\.5%/);
    expect(output).toContain('market_closed: 2');
  });

  it('emits decision rows for shadow slices', () => {
    const fixture = createFixture();
    const output = runShadowReport(['--decision'], {
      POLYSIGNAL_DB_PATH: fixture.dbPath,
      POLYSIGNAL_HEARTBEAT_PATH: fixture.heartbeatPath,
      POLYSIGNAL_SCAN_LOG_PATH: fixture.logPath,
      POLYSIGNAL_ANALYSIS_DIR: fixture.analysisDir
    });

    expect(output).toContain('DECISION');
    expect(output).toMatch(/hybrid\s+\|\s+70-80\s+\|\s+2\s+\|\s+1\s+\|\s+50\.0%\s+\|\s+9\.5%/);
    expect(output).toContain('FAIL');
  });

  it('writes a RE_ENABLE decision artifact when a slice meets the validation bar', () => {
    const fixture = createFixture(Array.from({ length: 20 }, (_, index) => ({
      id: `re-enable-${index}`,
      origin: 'hybrid',
      confidence: 78,
      tpFirst: index < 15 ? 1 : 0,
      maxFavorable: 2.6,
      maxAdverse: -0.5,
      netMaxFavorable: 0.8
    })));

    const output = runShadowReport(['--decision'], {
      POLYSIGNAL_DB_PATH: fixture.dbPath,
      POLYSIGNAL_HEARTBEAT_PATH: fixture.heartbeatPath,
      POLYSIGNAL_SCAN_LOG_PATH: fixture.logPath,
      POLYSIGNAL_ANALYSIS_DIR: fixture.analysisDir
    });

    const artifactPath = path.join(fixture.analysisDir, 'SHADOW_DECISION_DAY14.md');
    const artifact = fs.readFileSync(artifactPath, 'utf8');

    expect(output).toContain('decision_verdict: RE_ENABLE');
    expect(artifact.startsWith('VERDICT: RE_ENABLE')).toBe(true);
  });

  it('writes a PARTIAL decision artifact when only the partial bar is met', () => {
    const fixture = createFixture(Array.from({ length: 10 }, (_, index) => ({
      id: `partial-${index}`,
      origin: 'catalyst_convergence',
      confidence: 68,
      tpFirst: index < 8 ? 1 : 0,
      maxFavorable: 1.9,
      maxAdverse: -0.6,
      netMaxFavorable: 0.2
    })));

    runShadowReport(['--decision'], {
      POLYSIGNAL_DB_PATH: fixture.dbPath,
      POLYSIGNAL_HEARTBEAT_PATH: fixture.heartbeatPath,
      POLYSIGNAL_SCAN_LOG_PATH: fixture.logPath,
      POLYSIGNAL_ANALYSIS_DIR: fixture.analysisDir
    });

    const artifactPath = path.join(fixture.analysisDir, 'SHADOW_DECISION_DAY14.md');
    const artifact = fs.readFileSync(artifactPath, 'utf8');
    expect(artifact.startsWith('VERDICT: PARTIAL')).toBe(true);
  });

  it('writes a FAIL decision artifact when no slice qualifies', () => {
    const fixture = createFixture();

    runShadowReport(['--decision'], {
      POLYSIGNAL_DB_PATH: fixture.dbPath,
      POLYSIGNAL_HEARTBEAT_PATH: fixture.heartbeatPath,
      POLYSIGNAL_SCAN_LOG_PATH: fixture.logPath,
      POLYSIGNAL_ANALYSIS_DIR: fixture.analysisDir
    });

    const artifactPath = path.join(fixture.analysisDir, 'SHADOW_DECISION_DAY14.md');
    const artifact = fs.readFileSync(artifactPath, 'utf8');
    expect(artifact.startsWith('VERDICT: FAIL')).toBe(true);
  });

  it('passes node --check', () => {
    expect(() => {
      execFileSync('node', ['--check', scriptPath], {
        cwd: repoRoot,
        stdio: 'pipe'
      });
    }).not.toThrow();
  });
});
