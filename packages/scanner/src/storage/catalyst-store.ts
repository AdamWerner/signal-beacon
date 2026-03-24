import Database from 'better-sqlite3';
import { estimateExecutionCost } from '../intelligence/execution-feasibility.js';

export interface ExternalCatalystInput {
  sourceType: string;
  sourceKey: string;
  sourceFamily: string;
  eventType: string;
  title: string;
  body?: string | null;
  assetIds: string[];
  directionHint?: 'bull' | 'bear' | 'mixed' | 'neutral' | null;
  horizonMinutes?: number;
  causalStrength: number;
  noveltyScore: number;
  sourceQualityScore: number;
  normalizedSummary: string;
  metadata?: Record<string, unknown>;
  catalystTime?: string | null;
}

export interface CatalystLinkInput {
  signalId: string;
  catalystId: number;
  relation: 'primary' | 'supporting' | 'contradicting';
  evidenceScore: number;
}

export interface SourceFamilyDiagnostic {
  source_family: string;
  samples: number;
  hit_rate_30m: number;
  hit_rate_60m: number;
  avg_move_30m: number;
  avg_move_60m: number;
  expectancy_pct: number;
  reliability_score: number;
  updated_at: string;
}

export interface ExecutionReplayProfile {
  profile_key: string;
  asset_id: string;
  direction: 'bull' | 'bear';
  source_family: string;
  samples: number;
  win_rate_30m: number;
  avg_move_30m: number;
  avg_favorable_60m: number;
  avg_adverse_60m: number;
  expectancy_pct: number;
  typical_cost_pct: number;
  gate: 'open' | 'watch' | 'block' | 'unknown';
  updated_at: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class CatalystStore {
  constructor(private db: Database.Database) {}

  upsertCatalyst(input: ExternalCatalystInput): number {
    this.db.prepare(`
      INSERT INTO external_catalysts (
        source_type, source_key, source_family, event_type, title, body, asset_ids,
        direction_hint, horizon_minutes, causal_strength, novelty_score, source_quality_score,
        normalized_summary, metadata_json, catalyst_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        source_type = excluded.source_type,
        source_family = excluded.source_family,
        event_type = excluded.event_type,
        title = excluded.title,
        body = excluded.body,
        asset_ids = excluded.asset_ids,
        direction_hint = excluded.direction_hint,
        horizon_minutes = excluded.horizon_minutes,
        causal_strength = excluded.causal_strength,
        novelty_score = excluded.novelty_score,
        source_quality_score = excluded.source_quality_score,
        normalized_summary = excluded.normalized_summary,
        metadata_json = excluded.metadata_json,
        catalyst_time = excluded.catalyst_time
    `).run(
      input.sourceType,
      input.sourceKey,
      input.sourceFamily,
      input.eventType,
      input.title,
      input.body || null,
      JSON.stringify(input.assetIds),
      input.directionHint || null,
      input.horizonMinutes || 60,
      clamp(input.causalStrength, 0, 1),
      clamp(input.noveltyScore, 0, 1),
      clamp(input.sourceQualityScore, 0, 1),
        input.normalizedSummary,
        JSON.stringify(input.metadata || {}),
        input.catalystTime || null
    );

    const row = this.db.prepare(`
      SELECT id
      FROM external_catalysts
      WHERE source_key = ?
      LIMIT 1
    `).get(input.sourceKey) as { id: number } | undefined;

    if (!row) {
      throw new Error(`Failed to upsert catalyst ${input.sourceKey}`);
    }
    return row.id;
  }

  linkSignal(input: CatalystLinkInput): void {
    const signalExists = this.db.prepare(`
      SELECT 1
      FROM signals
      WHERE id = ?
      LIMIT 1
    `).get(input.signalId);
    if (!signalExists) {
      throw new Error(`Cannot link catalyst: signal ${input.signalId} not found`);
    }

    const catalystExists = this.db.prepare(`
      SELECT 1
      FROM external_catalysts
      WHERE id = ?
      LIMIT 1
    `).get(input.catalystId);
    if (!catalystExists) {
      throw new Error(`Cannot link catalyst: catalyst ${input.catalystId} not found`);
    }

    this.db.prepare(`
      INSERT INTO signal_catalyst_links (
        signal_id, catalyst_id, relation, evidence_score, created_at
      ) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(signal_id, catalyst_id, relation) DO UPDATE SET
        evidence_score = excluded.evidence_score,
        created_at = datetime('now')
    `).run(
      input.signalId,
      input.catalystId,
      input.relation,
      clamp(input.evidenceScore, 0, 1)
    );
  }

  getRecentCatalysts(hours = 24, assetId?: string, limit = 50) {
    if (assetId) {
      return this.db.prepare(`
        SELECT *
        FROM external_catalysts
        WHERE created_at >= datetime('now', '-' || ? || ' hours')
          AND asset_ids LIKE '%' || ? || '%'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(hours, assetId, limit) as any[];
    }

    return this.db.prepare(`
      SELECT *
      FROM external_catalysts
      WHERE created_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(hours, limit) as any[];
  }

  countRecentSimilar(assetId: string, sourceFamily: string, hours = 24): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c
      FROM external_catalysts
      WHERE created_at >= datetime('now', '-' || ? || ' hours')
        AND source_family = ?
        AND asset_ids LIKE '%' || ? || '%'
    `).get(hours, sourceFamily, assetId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  getSignalCatalysts(signalId: string) {
    return this.db.prepare(`
      SELECT ec.*, scl.relation, scl.evidence_score
      FROM signal_catalyst_links scl
      JOIN external_catalysts ec ON ec.id = scl.catalyst_id
      WHERE scl.signal_id = ?
      ORDER BY CASE scl.relation
        WHEN 'primary' THEN 0
        WHEN 'supporting' THEN 1
        ELSE 2
      END, ec.created_at DESC
    `).all(signalId) as any[];
  }

  getSourceFamilyDiagnostics(limit = 20): SourceFamilyDiagnostic[] {
    return this.db.prepare(`
      SELECT *
      FROM source_family_diagnostics
      ORDER BY reliability_score DESC, samples DESC
      LIMIT ?
    `).all(limit) as SourceFamilyDiagnostic[];
  }

  getExecutionReplayProfile(
    assetId: string,
    direction: 'bull' | 'bear',
    sourceFamily: string
  ): ExecutionReplayProfile | null {
    const row = this.db.prepare(`
      SELECT *
      FROM execution_replay_profiles
      WHERE asset_id = ?
        AND direction = ?
        AND source_family = ?
      LIMIT 1
    `).get(assetId, direction, sourceFamily) as ExecutionReplayProfile | undefined;

    if (row) return row;

    const fallback = this.db.prepare(`
      SELECT *
      FROM execution_replay_profiles
      WHERE asset_id = ?
        AND direction = ?
      ORDER BY samples DESC, updated_at DESC
      LIMIT 1
    `).get(assetId, direction) as ExecutionReplayProfile | undefined;

    return fallback ?? null;
  }

  getSignalsMissingPrimaryCatalyst(days = 45): Array<{
    id: string;
    market_title: string;
    reasoning: string;
    matched_asset_id: string;
    matched_asset_name: string;
    suggested_action: string;
    confidence: number;
    whale_detected: number;
    whale_amount_usd: number | null;
    timestamp: string;
  }> {
    return this.db.prepare(`
      SELECT s.id, s.market_title, s.reasoning, s.matched_asset_id, s.matched_asset_name,
             s.suggested_action, s.confidence, s.whale_detected, s.whale_amount_usd, s.timestamp
      FROM signals s
      JOIN signal_outcomes so ON so.signal_id = s.id
      LEFT JOIN signal_catalyst_links scl
        ON scl.signal_id = s.id
       AND scl.relation = 'primary'
      WHERE so.evaluated_at >= datetime('now', '-' || ? || ' days')
        AND scl.id IS NULL
      ORDER BY s.timestamp DESC
      LIMIT 1000
    `).all(days) as Array<{
      id: string;
      market_title: string;
      reasoning: string;
      matched_asset_id: string;
      matched_asset_name: string;
      suggested_action: string;
      confidence: number;
      whale_detected: number;
      whale_amount_usd: number | null;
      timestamp: string;
    }>;
  }

  refreshSourceFamilyDiagnostics(lookbackDays = 45): void {
    const rows = this.db.prepare(`
      SELECT
        ec.source_family,
        COUNT(DISTINCT so.signal_id) as samples,
        AVG(COALESCE(so.direction_correct_30m, 0)) as hit_rate_30m,
        AVG(COALESCE(so.direction_correct_60m, 0)) as hit_rate_60m,
        AVG(COALESCE(so.move_30m_pct, 0)) as avg_move_30m,
        AVG(COALESCE(so.move_60m_pct, 0)) as avg_move_60m,
        AVG(
          CASE
            WHEN COALESCE(so.direction_correct_30m, 0) = 1 THEN 3
            ELSE -2
          END
        ) as expectancy_pct
      FROM signal_outcomes so
      JOIN signal_catalyst_links scl
        ON scl.signal_id = so.signal_id
       AND scl.relation = 'primary'
      JOIN external_catalysts ec
        ON ec.id = scl.catalyst_id
      WHERE so.evaluated_at >= datetime('now', '-' || ? || ' days')
      GROUP BY ec.source_family
    `).all(lookbackDays) as Array<{
      source_family: string;
      samples: number;
      hit_rate_30m: number;
      hit_rate_60m: number;
      avg_move_30m: number;
      avg_move_60m: number;
      expectancy_pct: number;
    }>;

    const upsert = this.db.prepare(`
      INSERT INTO source_family_diagnostics (
        source_family, samples, hit_rate_30m, hit_rate_60m,
        avg_move_30m, avg_move_60m, expectancy_pct, reliability_score, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_family) DO UPDATE SET
        samples = excluded.samples,
        hit_rate_30m = excluded.hit_rate_30m,
        hit_rate_60m = excluded.hit_rate_60m,
        avg_move_30m = excluded.avg_move_30m,
        avg_move_60m = excluded.avg_move_60m,
        expectancy_pct = excluded.expectancy_pct,
        reliability_score = excluded.reliability_score,
        updated_at = datetime('now')
    `);

    for (const row of rows) {
      const reliability = row.samples < 4
        ? 0.5
        : clamp(
            0.25 +
            (row.hit_rate_30m * 0.4) +
            (row.hit_rate_60m * 0.2) +
            clamp(row.avg_move_30m / 1.5, -0.15, 0.15) +
            clamp(row.expectancy_pct / 6, -0.15, 0.2),
            0,
            1
          );

      upsert.run(
        row.source_family,
        row.samples,
        row.hit_rate_30m,
        row.hit_rate_60m,
        row.avg_move_30m,
        row.avg_move_60m,
        row.expectancy_pct,
        reliability
      );
    }
  }

  refreshExecutionReplayProfiles(lookbackDays = 45): void {
    const rows = this.db.prepare(`
      SELECT
        so.asset_id,
        CASE
          WHEN UPPER(s.suggested_action) LIKE '%BULL%' THEN 'bull'
          ELSE 'bear'
        END as direction,
        ec.source_family,
        COUNT(*) as samples,
        AVG(COALESCE(so.direction_correct_30m, 0)) as win_rate_30m,
        AVG(COALESCE(so.move_30m_pct, 0)) as avg_move_30m,
        AVG(COALESCE(so.favorable_peak_60m_pct, 0)) as avg_favorable_60m,
        AVG(COALESCE(so.adverse_peak_60m_pct, 0)) as avg_adverse_60m
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      JOIN signal_catalyst_links scl
        ON scl.signal_id = so.signal_id
       AND scl.relation = 'primary'
      JOIN external_catalysts ec
        ON ec.id = scl.catalyst_id
      WHERE so.evaluated_at >= datetime('now', '-' || ? || ' days')
      GROUP BY so.asset_id, direction, ec.source_family
    `).all(lookbackDays) as Array<{
      asset_id: string;
      direction: 'bull' | 'bear';
      source_family: string;
      samples: number;
      win_rate_30m: number;
      avg_move_30m: number;
      avg_favorable_60m: number;
      avg_adverse_60m: number;
    }>;

    const upsert = this.db.prepare(`
      INSERT INTO execution_replay_profiles (
        profile_key, asset_id, direction, source_family, samples, win_rate_30m, avg_move_30m,
        avg_favorable_60m, avg_adverse_60m, expectancy_pct, typical_cost_pct, gate, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(profile_key) DO UPDATE SET
        samples = excluded.samples,
        win_rate_30m = excluded.win_rate_30m,
        avg_move_30m = excluded.avg_move_30m,
        avg_favorable_60m = excluded.avg_favorable_60m,
        avg_adverse_60m = excluded.avg_adverse_60m,
        expectancy_pct = excluded.expectancy_pct,
        typical_cost_pct = excluded.typical_cost_pct,
        gate = excluded.gate,
        updated_at = datetime('now')
    `);

    for (const row of rows) {
      const cost = estimateExecutionCost(row.asset_id, 3).roundTripCostPct * 100;
      const expectancy = (row.win_rate_30m * 3) - ((1 - row.win_rate_30m) * 2) - cost;

      let gate: ExecutionReplayProfile['gate'] = 'unknown';
      if (row.samples >= 8) {
        if (expectancy > 0.25 && row.win_rate_30m >= 0.54) {
          gate = 'open';
        } else if (expectancy < -0.10 || row.win_rate_30m < 0.45) {
          gate = 'block';
        } else {
          gate = 'watch';
        }
      } else if (row.samples >= 4) {
        gate = 'watch';
      }

      upsert.run(
        `${row.asset_id}:${row.direction}:${row.source_family}`,
        row.asset_id,
        row.direction,
        row.source_family,
        row.samples,
        row.win_rate_30m,
        row.avg_move_30m,
        row.avg_favorable_60m,
        row.avg_adverse_60m,
        expectancy,
        cost,
        gate
      );
    }
  }
}
