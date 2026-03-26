import Database from 'better-sqlite3';

export interface Signal {
  id: string;
  signal_origin: 'polymarket' | 'catalyst_convergence' | 'hybrid';
  timestamp: string;
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_amount_usd: number | null;
  matched_asset_id: string;
  matched_asset_name: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggested_action: string;
  suggested_instruments: string; // JSON array as string
  reasoning: string;
  confidence: number;
  requires_judgment: boolean;
  deduplication_key: string | null;
  ai_analysis: string | null;
  verification_status: 'pending' | 'approved' | 'rejected' | 'needs_review';
  verification_score: number;
  verification_reason: string | null;
  verification_flags: string;
  verification_source: string | null;
  verification_record: string | null;
  verification_updated_at: string | null;
  push_sent_at: string | null;
  push_channel: string | null;
  primary_source_family?: string | null;
  catalyst_score?: number | null;
  catalyst_summary?: string | null;
  execution_replay_gate?: 'open' | 'watch' | 'block' | 'unknown' | null;
  execution_replay_expectancy_pct?: number | null;
  execution_replay_samples?: number | null;
  execution_replay_win_rate?: number | null;
  push_gate_outcome?: string | null;
  status: 'new' | 'viewed' | 'dismissed' | 'acted';
}

export interface InsertSignal {
  id: string;
  signal_origin: 'polymarket' | 'catalyst_convergence' | 'hybrid';
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_amount_usd: number | null;
  matched_asset_id: string;
  matched_asset_name: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggested_action: string;
  suggested_instruments: Array<{
    name: string;
    avanza_id: string;
    leverage: number | null;
    avanza_url: string;
  }>;
  reasoning: string;
  confidence: number;
  requires_judgment: boolean;
  deduplication_key: string;
  verification_status: 'pending' | 'approved' | 'rejected' | 'needs_review';
  verification_score: number;
  verification_reason: string;
  verification_flags: string[];
  verification_source: string;
  verification_record: string | null;
}

export class SignalStore {
  constructor(private db: Database.Database) {}

  insert(signal: InsertSignal): void {
    const stmt = this.db.prepare(`
      INSERT INTO signals (
        id, signal_origin, market_condition_id, market_slug, market_title,
        odds_before, odds_now, delta_pct, time_window_minutes,
        whale_detected, whale_amount_usd, matched_asset_id, matched_asset_name,
        polarity, suggested_action, suggested_instruments, reasoning, confidence,
        requires_judgment, deduplication_key,
        verification_status, verification_score, verification_reason,
        verification_flags, verification_source, verification_record, verification_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      signal.id,
      signal.signal_origin,
      signal.market_condition_id,
      signal.market_slug,
      signal.market_title,
      signal.odds_before,
      signal.odds_now,
      signal.delta_pct,
      signal.time_window_minutes,
      signal.whale_detected ? 1 : 0,
      signal.whale_amount_usd,
      signal.matched_asset_id,
      signal.matched_asset_name,
      signal.polarity,
      signal.suggested_action,
      JSON.stringify(signal.suggested_instruments),
      signal.reasoning,
      signal.confidence,
      signal.requires_judgment ? 1 : 0,
      signal.deduplication_key,
      signal.verification_status,
      signal.verification_score,
      signal.verification_reason,
      JSON.stringify(signal.verification_flags),
      signal.verification_source,
      signal.verification_record
    );
  }

  updateCatalystContext(
    id: string,
    fields: {
      primarySourceFamily: string;
      catalystScore: number;
      catalystSummary: string;
      executionReplayGate: 'open' | 'watch' | 'block' | 'unknown';
      executionReplayExpectancyPct: number;
      executionReplaySamples: number;
      executionReplayWinRate: number;
      confidence: number;
      reasoning: string;
    }
  ): void {
    this.db.prepare(`
      UPDATE signals
      SET primary_source_family = ?,
          catalyst_score = ?,
          catalyst_summary = ?,
          execution_replay_gate = ?,
          execution_replay_expectancy_pct = ?,
          execution_replay_samples = ?,
          execution_replay_win_rate = ?,
          confidence = ?,
          reasoning = ?
      WHERE id = ?
    `).run(
      fields.primarySourceFamily,
      fields.catalystScore,
      fields.catalystSummary,
      fields.executionReplayGate,
      fields.executionReplayExpectancyPct,
      fields.executionReplaySamples,
      fields.executionReplayWinRate,
      fields.confidence,
      fields.reasoning,
      id
    );
  }

  findById(id: string): Signal | undefined {
    const stmt = this.db.prepare('SELECT * FROM signals WHERE id = ?');
    return stmt.get(id) as Signal | undefined;
  }

  findAll(limit = 100, status?: Signal['status']): Signal[] {
    const stmt = status
      ? this.db.prepare('SELECT * FROM signals WHERE status = ? ORDER BY timestamp DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?');

    return status ? stmt.all(status, limit) as Signal[] : stmt.all(limit) as Signal[];
  }

  /** Filter by hours (recency), min confidence, and optional status */
  findFiltered(opts: { hours?: number; minConfidence?: number; status?: Signal['status']; limit?: number }): Signal[] {
    const { hours, minConfidence, status, limit = 200 } = opts;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (hours) {
      conditions.push(`timestamp >= datetime('now', '-' || ? || ' hours')`);
      params.push(hours);
    }
    if (minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(minConfidence);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const stmt = this.db.prepare(`SELECT * FROM signals ${where} ORDER BY timestamp DESC LIMIT ?`);
    return stmt.all(...params) as Signal[];
  }

  findByAssetIds(
    assetIds: string[],
    opts: { hours?: number; minConfidence?: number; status?: Signal['status']; limit?: number } = {}
  ): Signal[] {
    if (assetIds.length === 0) return [];

    const { hours, minConfidence, status, limit = 200 } = opts;
    const conditions: string[] = [`matched_asset_id IN (${assetIds.map(() => '?').join(', ')})`];
    const params: (string | number)[] = [...assetIds];

    if (hours) {
      conditions.push(`timestamp >= datetime('now', '-' || ? || ' hours')`);
      params.push(hours);
    }
    if (minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(minConfidence);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    params.push(limit);
    const stmt = this.db.prepare(`
      SELECT *
      FROM signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(...params) as Signal[];
  }

  findByMarket(market_condition_id: string): Signal[] {
    const stmt = this.db.prepare(`
      SELECT * FROM signals
      WHERE market_condition_id = ?
      ORDER BY timestamp DESC
    `);

    return stmt.all(market_condition_id) as Signal[];
  }

  /**
   * Find the most recent signal with a given deduplication key within N hours.
   * Used to prevent duplicate signals for the same market+asset combination.
   */
  findRecentByDeduplicationKey(key: string, hours: number): Signal | null {
    const stmt = this.db.prepare(`
      SELECT * FROM signals
      WHERE deduplication_key = ?
        AND timestamp >= datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    return (stmt.get(key, hours) as Signal) ?? null;
  }

  updateStatus(id: string, status: Signal['status']): void {
    const stmt = this.db.prepare('UPDATE signals SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  updateConfidence(id: string, confidence: number): void {
    const stmt = this.db.prepare('UPDATE signals SET confidence = ? WHERE id = ?');
    stmt.run(Math.min(confidence, 100), id);
  }

  updateSuggestedAction(id: string, suggestedAction: string): void {
    this.db.prepare('UPDATE signals SET suggested_action = ? WHERE id = ?').run(suggestedAction, id);
  }

  getAiAnalysis(id: string): string | null {
    const row = this.db.prepare('SELECT ai_analysis FROM signals WHERE id = ?').get(id) as { ai_analysis: string | null } | undefined;
    return row?.ai_analysis ?? null;
  }

  setAiAnalysis(id: string, analysis: string): void {
    this.db.prepare('UPDATE signals SET ai_analysis = ? WHERE id = ?').run(analysis, id);
  }

  setVerification(
    id: string,
    verification: {
      status: Signal['verification_status'];
      score: number;
      reason: string;
      flags: string[];
      source: string;
      record?: string | null;
    }
  ): void {
    this.db.prepare(`
      UPDATE signals
      SET verification_status = ?,
          verification_score = ?,
          verification_reason = ?,
          verification_flags = ?,
          verification_source = ?,
          verification_record = ?,
          verification_updated_at = datetime('now')
      WHERE id = ?
    `).run(
      verification.status,
      Math.max(0, Math.min(100, verification.score)),
      verification.reason,
      JSON.stringify(verification.flags),
      verification.source,
      verification.record ?? null,
      id
    );
  }

  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new,
        SUM(CASE WHEN status = 'viewed' THEN 1 ELSE 0 END) as viewed,
        SUM(CASE WHEN status = 'acted' THEN 1 ELSE 0 END) as acted,
        AVG(confidence) as avg_confidence
      FROM signals
    `);

    return stmt.get() as {
      total: number;
      new: number;
      viewed: number;
      acted: number;
      avg_confidence: number;
    };
  }

  /** Timestamp of the most recently created signal, or null if none */
  getLatestTimestamp(): string | null {
    const row = this.db.prepare(
      `SELECT timestamp FROM signals ORDER BY timestamp DESC LIMIT 1`
    ).get() as { timestamp: string } | undefined;
    return row?.timestamp ?? null;
  }

  /** Auto-dismiss signals that are still 'new' after N hours */
  expireStale(hoursOld: number): number {
    const stmt = this.db.prepare(`
      UPDATE signals SET status = 'dismissed'
      WHERE status = 'new'
        AND timestamp < datetime('now', '-' || ? || ' hours')
    `);
    return stmt.run(hoursOld).changes;
  }

  /** Dismiss signals whose market is no longer active (resolved or noise-cleaned) */
  dismissFromInactiveMarkets(): number {
    const stmt = this.db.prepare(`
      UPDATE signals SET status = 'dismissed'
      WHERE status IN ('new', 'viewed')
        AND market_condition_id NOT IN (
          SELECT condition_id FROM tracked_markets WHERE is_active = TRUE
        )
    `);
    return stmt.run().changes;
  }

  cleanupOld(daysToKeep: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM signals
      WHERE timestamp < datetime('now', '-' || ? || ' days')
        AND status != 'acted'
    `);

    const info = stmt.run(daysToKeep);
    return info.changes;
  }

  markPushed(signalIds: string[], channel = 'ha'): void {
    if (signalIds.length === 0) return;
    const stmt = this.db.prepare(`
      UPDATE signals
      SET push_sent_at = datetime('now'),
          push_channel = ?
      WHERE id = ?
    `);

    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(channel, id);
      }
    });

    tx(signalIds);
  }

  updatePushGateOutcome(signalId: string, outcome: string): void {
    this.db.prepare(`
      UPDATE signals
      SET push_gate_outcome = ?
      WHERE id = ?
    `).run(outcome, signalId);
  }

  getLatestPushedSignalForAsset(assetId: string, withinMinutes = 240): Signal | null {
    const stmt = this.db.prepare(`
      SELECT * FROM signals
      WHERE matched_asset_id = ?
        AND push_sent_at IS NOT NULL
        AND timestamp >= datetime('now', '-' || ? || ' minutes')
      ORDER BY push_sent_at DESC, timestamp DESC
      LIMIT 1
    `);
    return (stmt.get(assetId, withinMinutes) as Signal) ?? null;
  }

  countDistinctApprovedMarketsForAssetDirection(
    assetId: string,
    direction: 'bull' | 'bear',
    withinMinutes = 60
  ): number {
    const directionWord = direction === 'bull' ? 'BULL' : 'BEAR';
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT market_condition_id) as c
      FROM signals
      WHERE matched_asset_id = ?
        AND verification_status = 'approved'
        AND UPPER(suggested_action) LIKE '%' || ? || '%'
        AND timestamp >= datetime('now', '-' || ? || ' minutes')
    `).get(assetId, directionWord, withinMinutes) as { c: number } | undefined;

    return row?.c ?? 0;
  }

  getPushPerformancePolicy(assetId: string): {
    samples: number;
    hitRate30m: number;
    avgMove30m: number;
    reliabilityScore: number;
    gate: 'open' | 'watch' | 'block';
  } | null {
    try {
      const row = this.db.prepare(`
        SELECT samples, hit_rate_30m, avg_move_30m, reliability_score, gate
        FROM asset_push_performance
        WHERE asset_id = ?
        LIMIT 1
      `).get(assetId) as {
        samples: number;
        hit_rate_30m: number;
        avg_move_30m: number;
        reliability_score: number;
        gate: 'open' | 'watch' | 'block';
      } | undefined;

      if (!row) return null;
      return {
        samples: row.samples || 0,
        hitRate30m: row.hit_rate_30m || 0,
        avgMove30m: row.avg_move_30m || 0,
        reliabilityScore: row.reliability_score || 0,
        gate: row.gate || 'watch'
      };
    } catch {
      return null;
    }
  }

  getDirectionalPushPerformance(
    assetId: string,
    direction: 'bull' | 'bear',
    lookbackDays = 30
  ): {
    samples: number;
    hitRate30m: number;
    avgMove30m: number;
  } | null {
    try {
      const directionWord = direction === 'bull' ? 'BULL' : 'BEAR';
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as samples,
          AVG(COALESCE(so.direction_correct_30m, 0)) as hit_rate_30m,
          AVG(COALESCE(so.move_30m_pct, 0)) as avg_move_30m
        FROM signal_outcomes so
        JOIN signals s ON s.id = so.signal_id
        WHERE so.asset_id = ?
          AND so.source = 'push_timestamp'
          AND UPPER(s.suggested_action) LIKE '%' || ? || '%'
          AND so.evaluated_at >= datetime('now', '-' || ? || ' days')
      `).get(assetId, directionWord, lookbackDays) as {
        samples: number;
        hit_rate_30m: number;
        avg_move_30m: number;
      } | undefined;

      if (!row || !row.samples) return null;
      return {
        samples: row.samples || 0,
        hitRate30m: row.hit_rate_30m || 0,
        avgMove30m: row.avg_move_30m || 0
      };
    } catch {
      return null;
    }
  }

  getPushPolicyConfig(market: 'swedish' | 'us'): {
    minConfidence: number;
    minDeltaPct: number;
    minEvidenceScore: number;
    updatedAt: string;
  } | null {
    try {
      const row = this.db.prepare(`
        SELECT min_confidence, min_delta_pct, min_evidence_score, updated_at
        FROM push_policy_config
        WHERE market = ?
        LIMIT 1
      `).get(market) as {
        min_confidence: number;
        min_delta_pct: number;
        min_evidence_score: number;
        updated_at: string;
      } | undefined;

      if (!row) return null;
      return {
        minConfidence: row.min_confidence || 65,
        minDeltaPct: row.min_delta_pct || 15,
        minEvidenceScore: row.min_evidence_score || 3,
        updatedAt: row.updated_at
      };
    } catch {
      return null;
    }
  }

  getSourceFamilyPerformance(sourceFamily: string): {
    samples: number;
    hitRate30m: number;
    hitRate60m: number;
    expectancyPct: number;
    reliabilityScore: number;
  } | null {
    try {
      const row = this.db.prepare(`
        SELECT samples, hit_rate_30m, hit_rate_60m, expectancy_pct, reliability_score
        FROM source_family_diagnostics
        WHERE source_family = ?
        LIMIT 1
      `).get(sourceFamily) as {
        samples: number;
        hit_rate_30m: number;
        hit_rate_60m: number;
        expectancy_pct: number;
        reliability_score: number;
      } | undefined;

      if (!row) return null;
      return {
        samples: row.samples || 0,
        hitRate30m: row.hit_rate_30m || 0,
        hitRate60m: row.hit_rate_60m || 0,
        expectancyPct: row.expectancy_pct || 0,
        reliabilityScore: row.reliability_score || 0
      };
    } catch {
      return null;
    }
  }

  getAssetPerformanceAdjustment(assetId: string): {
    adjustment: number;
    samples: number;
    reliabilityScore: number;
  } | null {
    const row = this.db.prepare(`
      SELECT suggested_confidence_adjustment, samples, reliability_score
      FROM asset_performance
      WHERE asset_id = ?
      LIMIT 1
    `).get(assetId) as {
      suggested_confidence_adjustment: number;
      samples: number;
      reliability_score: number;
    } | undefined;

    if (!row) return null;
    return {
      adjustment: row.suggested_confidence_adjustment || 0,
      samples: row.samples || 0,
      reliabilityScore: row.reliability_score || 0
    };
  }
}
