import { Router } from 'express';
import { scanner, getTopSignals, analyzeSignal, IntelligenceEngine, isNoiseMarketQuestion } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function escapeHtml(value: unknown): string {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isApprovedForRanking(signal: any): boolean {
  return signal.verification_status === 'approved' &&
    ['claude', 'guard', 'guard_allowlist'].includes(String(signal.verification_source || ''));
}

function parseSignal(signal: any) {
  const parsedInstruments = safeJsonParse(signal.suggested_instruments, []);
  const normalizedInstruments = Array.isArray(parsedInstruments)
    ? parsedInstruments.map((instrument: any) => {
        const currentUrl = String(instrument?.avanza_url || '');
        const currentName = String(instrument?.name || '');
        let nextUrl = currentUrl;

        if (currentUrl.includes('avanza.se/sok?query=')) {
          const queryPart = currentUrl.split('query=')[1] || '';
          const decoded = decodeURIComponent(queryPart || '');
          const cleaned = decoded.replace(/^(BULL|BEAR)\s+/i, '').trim();
          const normalizedQuery = cleaned ? `${cleaned} certifikat` : decoded;
          nextUrl = `https://www.avanza.se/sok.html?query=${encodeURIComponent(normalizedQuery)}`;
        } else if (!currentUrl && currentName) {
          const cleaned = currentName
            .replace(/^(BULL|BEAR)\s+/i, '')
            .replace(/\s+X\d+\s+AVA$/i, '')
            .trim();
          if (cleaned) {
            nextUrl = `https://www.avanza.se/sok.html?query=${encodeURIComponent(`${cleaned} certifikat`)}`;
          }
        }

        return {
          ...instrument,
          avanza_url: nextUrl
        };
      })
    : [];

  return {
    ...signal,
    suggested_instruments: normalizedInstruments,
    verification_flags: Array.isArray(signal.verification_flags)
      ? signal.verification_flags
      : safeJsonParse<string[]>(signal.verification_flags, [])
  };
}

// GET /api/signals - Get signals with optional filters
// Query params: limit, status, hours (recency), min_confidence
router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const status = req.query.status as any;
    const hours = req.query.hours ? parseInt(req.query.hours as string) : undefined;
    const minConfidence = req.query.min_confidence ? parseInt(req.query.min_confidence as string) : undefined;

    const signals = (hours !== undefined || minConfidence !== undefined)
      ? services.signalStore.findFiltered({ hours, minConfidence, status, limit })
      : services.signalStore.findAll(limit, status);

    const parsed = signals
      .filter(signal => !isNoiseMarketQuestion(String(signal.market_title || '')))
      .map(parseSignal);

    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// GET /api/signals/top - AI-ranked top 10 signals (must be before /:id)
router.get('/top', async (req, res) => {
  try {
    const includeUnverified = req.query.include_unverified === 'true';
    const allSignals = services.signalStore.findAll(500);
    const signals = allSignals.filter(s =>
      s.status !== 'dismissed' &&
      !isNoiseMarketQuestion(String(s.market_title || ''))
    );
    // Dedup + AI ranking handled inside getTopSignals
    const top = await getTopSignals(signals, { includeUnverified });
    const parsed = top.map(signal => ({
      ...parseSignal(signal),
      also_affects: (signal as any).also_affects ?? []
    }));
    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch top signals' });
  }
});

// Swedish assets
const SWEDISH_ASSET_IDS = new Set([
  'defense-saab',
  'steel-ssab',
  'mining-boliden',
  'telecom-ericsson',
  'gaming-evolution',
  'retail-hm',
  'auto-volvo'
]);
const SWEDISH_NAME_FRAGMENTS = ['saab', 'ssab', 'boliden', 'ericsson', 'evolution', 'h&m', 'hennes', 'volvo'];

// GET /api/signals/top/swedish - Top 5 Swedish-asset signals (must be before /:id)
router.get('/top/swedish', (req, res) => {
  try {
    const includeUnverified = req.query.include_unverified === 'true';
    const signals = services.signalStore.findFiltered({ hours: 48, limit: 500 });
    const swedishPool = signals
      .filter(s =>
        s.status !== 'dismissed' &&
        !isNoiseMarketQuestion(String(s.market_title || '')) &&
        (includeUnverified || isApprovedForRanking(s)) &&
        (SWEDISH_ASSET_IDS.has(s.matched_asset_id) ||
        SWEDISH_NAME_FRAGMENTS.some(f => s.matched_asset_name.toLowerCase().includes(f)))
      )
      .sort((a, b) => b.confidence - a.confidence);

    const byAsset = new Map<string, any>();
    for (const signal of swedishPool) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    const swedish = Array.from(byAsset.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(parseSignal);
    res.json(swedish);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Swedish signals' });
  }
});

// GET /api/signals/stats - Get signal statistics (must be before /:id)
router.get('/stats', (req, res) => {
  try {
    const stats = services.signalStore.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/signals/:id/detail - Full signal detail HTML page (must be before /:id plain)
router.get('/:id/detail', async (req, res) => {
  try {
    const signal = services.signalStore.findById(req.params.id);
    if (!signal) {
      return res.status(404).send('<h1>Signal not found</h1>');
    }

    // AI analysis — load from cache or generate
    let aiAnalysis = signal.ai_analysis;
    if (!aiAnalysis) {
      try {
        aiAnalysis = await analyzeSignal(signal);
        if (aiAnalysis) services.signalStore.setAiAnalysis(signal.id, aiAnalysis);
      } catch { /* non-fatal */ }
    }

    const instruments = safeJsonParse(signal.suggested_instruments, []);
    const verificationFlags = safeJsonParse<string[]>(signal.verification_flags, []);
    const verificationRecord = signal.verification_record
      ? safeJsonParse(signal.verification_record, signal.verification_record)
      : null;
    const snapshots = services.snapshotStore.getHistory(signal.market_condition_id, 24);
    const whales = services.whaleStore.getRecentByMarket(signal.market_condition_id, 60 * 24);

    // Related signals: same market (other assets) + same asset (other markets), last 24h
    const allRecent = services.signalStore.findFiltered({ hours: 24, limit: 100 });
    const relatedByMarket = allRecent
      .filter(s => s.market_condition_id === signal.market_condition_id && s.id !== signal.id)
      .slice(0, 5);
    const relatedByAsset = allRecent
      .filter(s => s.matched_asset_id === signal.matched_asset_id && s.id !== signal.id && s.market_condition_id !== signal.market_condition_id)
      .slice(0, 5);

    const marketMeta = services.marketStore.findByConditionId(signal.market_condition_id);
    const eventSlug = marketMeta?.event_slug || null;
    const polyUrl = eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : `https://polymarket.com/search?q=${encodeURIComponent(`${signal.market_title.substring(0, 40)} ${signal.matched_asset_name}`)}`;

    const sparkPoints = snapshots.slice(0, 48).reverse()
      .map(s => `${(s.odds_yes * 100).toFixed(1)}`)
      .join(',');

    const whaleSummary = whales.length > 0
      ? whales.slice(0, 5).map(w =>
          `<li>${w.side} $${w.size_usd.toLocaleString()} @ ${(w.price_at_trade ?? 0 * 100).toFixed(0)}% YES</li>`
        ).join('')
      : '<li>No recent whale activity</li>';

    const instHtml = instruments.length > 0
      ? instruments.map((i: any) => i.avanza_url
          ? `<a href="${i.avanza_url}" target="_blank">${i.name}</a>`
          : `<span>${i.name}</span>`
        ).join(' | ')
      : 'No instruments';

    const isBull = signal.suggested_action.toLowerCase().includes('bull');
    const dirColor = isBull ? '#00ff88' : '#ff3d6e';
    const deltaSign = signal.delta_pct > 0 ? '+' : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolySignal: ${signal.matched_asset_name}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d1a; color: #e2e2ee; margin: 0; padding: 24px; max-width: 700px; }
  h1 { color: ${dirColor}; font-size: 1.5rem; margin-bottom: 4px; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .box { background: #161625; border: 1px solid #2a2a3e; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .label { font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .big { font-size: 2rem; font-family: monospace; color: ${dirColor}; font-weight: bold; }
  .oddsbar { height: 6px; background: #2a2a3e; border-radius: 3px; margin-top: 8px; overflow: hidden; }
  .oddsbar div { height: 100%; background: ${dirColor}; border-radius: 3px; }
  a { color: #4fc3f7; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; font-size: 0.9rem; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; border: 1px solid ${dirColor}33; color: ${dirColor}; }
  .footer { color: #444; font-size: 0.75rem; margin-top: 32px; }
</style>
</head>
<body>
<h1>${isBull ? '📈 BULL' : '📉 BEAR'} ${signal.matched_asset_name}</h1>
<div class="sub">Signal generated ${new Date(signal.timestamp).toLocaleString()} · Confidence: ${signal.confidence}%</div>

<div class="box">
  <div class="label">Market Question</div>
  <p style="margin:0;line-height:1.5">${signal.market_title}</p>
  <a href="${polyUrl}" target="_blank" style="font-size:0.8rem">View on Polymarket ↗</a>
</div>

<div class="box">
  <div class="label">Odds Change</div>
  <div class="big">${deltaSign}${signal.delta_pct.toFixed(1)}%</div>
  <div style="font-size:0.85rem;color:#888;margin-top:4px">
    ${(signal.odds_before * 100).toFixed(0)}% → ${(signal.odds_now * 100).toFixed(0)}% YES
    &nbsp;over ${signal.time_window_minutes} min
  </div>
  <div class="oddsbar"><div style="width:${signal.odds_now * 100}%"></div></div>
</div>

${aiAnalysis ? `
<div class="box" style="border-color:${dirColor}44">
  <div class="label" style="color:${dirColor}">🤖 AI Analysis</div>
  <p style="margin:0;line-height:1.6;font-size:0.9rem">${aiAnalysis.replace(/\n/g, '<br>')}</p>
</div>
` : ''}
<div class="box">
  <div class="label">Signal Reasoning</div>
  <p style="margin:0;line-height:1.5;font-size:0.9rem">${signal.reasoning}</p>
</div>

<div class="box">
  <div class="label">Verification</div>
  <p style="margin:0;line-height:1.5;font-size:0.9rem">
    Status: ${signal.verification_status || 'pending'} (${signal.verification_source || 'none'})<br>
    Score: ${signal.verification_score ?? 0}%<br>
    Reason: ${signal.verification_reason || 'No decision record'}<br>
    Flags: ${verificationFlags.length > 0 ? verificationFlags.join(', ') : 'none'}
  </p>
  ${verificationRecord ? `<pre style="margin-top:10px;overflow:auto;font-size:0.75rem;background:#111122;padding:8px;border-radius:6px">${escapeHtml(JSON.stringify(verificationRecord, null, 2))}</pre>` : ''}
</div>

<div class="box">
  <div class="label">Suggested Instruments (Avanza)</div>
  <p style="margin:0;font-size:0.9rem">${instHtml}</p>
</div>

<div class="box">
  <div class="label">Recent Whale Activity (last 24h)</div>
  <ul>${whaleSummary}</ul>
</div>

<div class="box">
  <div class="label">Odds History (last 24h snapshots)</div>
  <p style="margin:0;font-family:monospace;font-size:0.7rem;color:#666;word-break:break-all">${sparkPoints || 'No snapshot data'}</p>
</div>

${relatedByMarket.length > 0 ? `
<div class="box">
  <div class="label">Other Signals on This Market</div>
  <ul>
    ${relatedByMarket.map(s => {
      const d = s.suggested_action.toLowerCase().includes('bull') ? '📈' : '📉';
      const ds = s.delta_pct > 0 ? '+' : '';
      return `<li><a href="/api/signals/${s.id}/detail">${d} ${s.matched_asset_name} ${ds}${s.delta_pct.toFixed(1)}% (${s.confidence}%)</a></li>`;
    }).join('')}
  </ul>
</div>
` : ''}
${relatedByAsset.length > 0 ? `
<div class="box">
  <div class="label">Other ${signal.matched_asset_name} Signals (last 24h)</div>
  <ul>
    ${relatedByAsset.map(s => {
      const d = s.suggested_action.toLowerCase().includes('bull') ? '📈' : '📉';
      const ds = s.delta_pct > 0 ? '+' : '';
      return `<li><a href="/api/signals/${s.id}/detail">${d} ${s.market_title.substring(0, 55)} ${ds}${s.delta_pct.toFixed(1)}% (${s.confidence}%)</a></li>`;
    }).join('')}
  </ul>
</div>
` : ''}

<div class="footer">
  Signal ID: ${signal.id} · Last updated: ${new Date().toLocaleString()} · <a href="/api/signals/top" style="color:#4fc3f7">Top Signals</a> · <a href="javascript:history.back()">Back</a>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).send('<h1>Error generating detail page</h1>');
  }
});

// GET /api/signals/:id - Get single signal
router.get('/:id', (req, res) => {
  try {
    const signal = services.signalStore.findById(req.params.id);

    if (!signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    res.json(parseSignal(signal));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch signal' });
  }
});

// PUT /api/signals/:id/status - Update signal status
router.put('/:id/status', (req, res) => {
  try {
    const { status } = req.body;

    if (!['new', 'viewed', 'dismissed', 'acted'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    services.signalStore.updateStatus(req.params.id, status);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update signal' });
  }
});

// GET /api/signals/quality-report — pipeline health summary
router.get('/quality-report', (req, res) => {
  try {
    const db = (services as any).db;

    // Last 24h signal counts by status
    const statusRows = db.prepare(`
      SELECT verification_status, COUNT(*) as cnt,
             AVG(confidence) as avg_confidence
      FROM signals
      WHERE timestamp >= datetime('now', '-24 hours')
      GROUP BY verification_status
    `).all() as Array<{ verification_status: string; cnt: number; avg_confidence: number }>;

    const byStatus: Record<string, { count: number; avg_confidence: number }> = {};
    let totalSignals = 0;
    for (const row of statusRows) {
      byStatus[row.verification_status] = {
        count: row.cnt,
        avg_confidence: Math.round(row.avg_confidence || 0)
      };
      totalSignals += row.cnt;
    }

    const pushedRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE timestamp >= datetime('now', '-24 hours')
        AND push_sent_at IS NOT NULL
    `).get() as { cnt: number };

    // Top rejection flags from rejected signals
    const rejectedRows = db.prepare(`
      SELECT verification_flags FROM signals
      WHERE timestamp >= datetime('now', '-24 hours')
        AND verification_status = 'rejected'
        AND verification_flags IS NOT NULL AND verification_flags != '[]'
    `).all() as Array<{ verification_flags: string }>;

    const flagCounts: Record<string, number> = {};
    for (const row of rejectedRows) {
      try {
        const flags: string[] = JSON.parse(row.verification_flags);
        for (const flag of flags) {
          flagCounts[flag] = (flagCounts[flag] || 0) + 1;
        }
      } catch { /* skip malformed */ }
    }
    const topRejectionFlags = Object.entries(flagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([flag, count]) => ({ flag, count }));

    // Backtest summary (last 7 days)
    const backtestRows = db.prepare(`
      SELECT market, date, signals_evaluated, hit_rate_30m, hit_rate_60m
      FROM daily_backtest_runs
      WHERE executed_at >= datetime('now', '-7 days')
      ORDER BY date DESC
    `).all() as Array<{
      market: string; date: string; signals_evaluated: number;
      hit_rate_30m: number; hit_rate_60m: number;
    }>;

    const bestAsset = db.prepare(`
      SELECT asset_name, hit_rate_60m FROM asset_performance
      ORDER BY hit_rate_60m DESC, samples DESC LIMIT 1
    `).get() as { asset_name: string; hit_rate_60m: number } | undefined;

    const worstAsset = db.prepare(`
      SELECT asset_name, hit_rate_60m FROM asset_performance
      WHERE samples >= 3 ORDER BY hit_rate_60m ASC LIMIT 1
    `).get() as { asset_name: string; hit_rate_60m: number } | undefined;

    // Feed health
    const feedTotal = db.prepare(`SELECT COUNT(*) as cnt FROM tweet_accounts WHERE collect_enabled = 1`).get() as { cnt: number };
    const feedActive = db.prepare(`
      SELECT COUNT(DISTINCT account_handle) as cnt FROM tweet_snapshots
      WHERE collected_at >= datetime('now', '-24 hours')
    `).get() as { cnt: number };

    res.json({
      last24h: {
        total_signals: totalSignals,
        approved: byStatus['approved']?.count ?? 0,
        rejected: byStatus['rejected']?.count ?? 0,
        needs_review: byStatus['needs_review']?.count ?? 0,
        pending: byStatus['pending']?.count ?? 0,
        pushed_to_ha: pushedRow.cnt,
        avg_confidence_approved: byStatus['approved']?.avg_confidence ?? 0,
        avg_confidence_rejected: byStatus['rejected']?.avg_confidence ?? 0,
        top_rejection_flags: topRejectionFlags
      },
      backtest_summary: {
        days_evaluated: [...new Set(backtestRows.map(r => r.date))].length,
        overall_hit_rate_30m: backtestRows.length
          ? +(backtestRows.reduce((s, r) => s + r.hit_rate_30m, 0) / backtestRows.length).toFixed(2)
          : null,
        best_asset: bestAsset?.asset_name ?? null,
        worst_asset: worstAsset?.asset_name ?? null
      },
      feed_health: {
        total_feeds_enabled: feedTotal.cnt,
        active_last_24h: feedActive.cnt,
        inactive: Math.max(0, feedTotal.cnt - feedActive.cnt)
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate quality report', message: error?.message });
  }
});

// Note: Briefing routes moved to /api/briefing (see routes/briefing.ts)

// GET /api/signals/intelligence/memory - Active intelligence memories
router.get('/intelligence/memory', (req, res) => {
  try {
    const intel = new IntelligenceEngine((services as any).db);
    const memories = intel.getActiveMemories();
    res.json(memories.map((m: any) => ({
      ...m,
      affected_assets: JSON.parse(m.affected_assets || '[]'),
      source_signals: JSON.parse(m.source_signals || '[]')
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch intelligence memory' });
  }
});

export default router;
