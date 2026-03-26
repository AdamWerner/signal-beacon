import { Router } from 'express';
import {
  scanner,
  getTopSignals,
  analyzeSignal,
  IntelligenceEngine,
  isNoiseMarketQuestion,
  SWEDISH_MARKET_ASSETS,
  isDashboardEligibleSignal,
  estimateExecutionCost
} from '@polysignal/scanner';

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

function normalizeAvanzaSearchTerm(value: string): string {
  return value
    .replace(/^(BULL|BEAR)\s+/i, '')
    .replace(/\s+X\d+\b.*$/i, '')
    .replace(/\s+certifikat\b/gi, '')
    .replace(/\s+(Technology|Holdings|Integrated|Services|Systems|Group|Global|Mobil|Gaming)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isApprovedForRanking(signal: any): boolean {
  return signal.verification_status === 'approved' &&
    ['claude', 'guard', 'guard_allowlist'].includes(String(signal.verification_source || ''));
}

function isApprovedForSwedishFocus(signal: any): boolean {
  if (signal.verification_status !== 'approved') return false;

  const source = String(signal.verification_source || '');
  if (['claude', 'guard', 'guard_allowlist'].includes(source)) {
    return true;
  }

  if (source !== 'fallback_guard') {
    return false;
  }

  const score = Number(signal.verification_score || 0);
  const flags = Array.isArray(signal.verification_flags)
    ? signal.verification_flags
    : safeJsonParse<string[]>(signal.verification_flags, []);
  const highRiskFlags = new Set([
    'unknown_entity',
    'no_link',
    'low_entity_confidence',
    'unknown_person_legal_event'
  ]);

  return score >= 70 && !flags.some((flag: string) => highRiskFlags.has(String(flag)));
}

function parseSignal(signal: any) {
  const parsedInstruments = safeJsonParse(signal.suggested_instruments, []);
  const normalizedInstruments = Array.isArray(parsedInstruments)
    ? parsedInstruments.map((instrument: any) => {
        const currentUrl = String(instrument?.avanza_url || '');
        const currentName = String(instrument?.name || '');
        let nextUrl = currentUrl;

        const hasLegacySearchUrl =
          currentUrl.includes('avanza.se/sok?query=') ||
          currentUrl.includes('avanza.se/sok.html?query=') ||
          currentUrl.includes('avanza.se/sok.html?q=');

        if (hasLegacySearchUrl) {
          const queryPart = currentUrl.includes('q=')
            ? (currentUrl.split('q=')[1] || '')
            : (currentUrl.split('query=')[1] || '');
          const decoded = decodeURIComponent(queryPart || '');
          const cleaned = normalizeAvanzaSearchTerm(decoded || currentName);
          const normalizedQuery = cleaned ? `${cleaned} certifikat` : decoded;
          nextUrl = `https://www.avanza.se/sok.html?query=${encodeURIComponent(normalizedQuery)}`;
        } else if (!currentUrl && currentName) {
          const cleaned = normalizeAvanzaSearchTerm(currentName);
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

type SwedishProxyRule = {
  assetId: string;
  assetName: string;
  searchTerm: string;
  families: string[];
  pattern: RegExp;
  confidencePenalty: number;
  reason: string;
};

const SWEDISH_PROXY_RULES: SwedishProxyRule[] = [
  {
    assetId: 'defense-saab',
    assetName: 'Saab B',
    searchTerm: 'SAAB B certifikat',
    families: ['defense_geopolitical'],
    pattern: /\b(nato|defense spending|missile|fighter jet|air defense|ukraine|russia|taiwan|gripen)\b/i,
    confidencePenalty: 8,
    reason: 'Swedish defense proxy: Saab is the clearest Avanza-tradable Nordic beneficiary.'
  },
  {
    assetId: 'omx30',
    assetName: 'OMX S30',
    searchTerm: 'OMXS30 certifikat',
    families: ['macro_rates', 'macro_growth', 'swedish_macro_proxy'],
    pattern: /\b(fed|ecb|riksbank|inflation|cpi|ppi|payroll|nfp|recession|pmi|consumer confidence|gdp|tariff|trade war)\b/i,
    confidencePenalty: 10,
    reason: 'Swedish macro proxy: OMX reacts quickly to the same Europe/US macro regime shift.'
  },
  {
    assetId: 'steel-ssab',
    assetName: 'SSAB',
    searchTerm: 'SSAB certifikat',
    families: ['regulation_sector', 'macro_growth'],
    pattern: /\b(steel|tariff|trade war|industrial policy|green steel)\b/i,
    confidencePenalty: 12,
    reason: 'Swedish industrial proxy: SSAB is directly exposed to tariff and steel-policy shifts.'
  },
  {
    assetId: 'mining-boliden',
    assetName: 'Boliden',
    searchTerm: 'Boliden certifikat',
    families: ['regulation_sector', 'macro_growth'],
    pattern: /\b(copper|mining|metal|tariff|trade war|industrial demand)\b/i,
    confidencePenalty: 12,
    reason: 'Swedish metals proxy: Boliden tracks Nordic metals demand and copper-sensitive macro.'
  }
];

function buildProxyInstrument(rule: SwedishProxyRule, direction: 'bull' | 'bear') {
  return [{
    name: `${direction.toUpperCase()} ${rule.assetName} X3 AVA`,
    avanza_id: '',
    leverage: 3,
    avanza_url: `https://www.avanza.se/sok.html?query=${encodeURIComponent(rule.searchTerm)}`,
    issuer: null
  }];
}

function buildSwedishProxySignals(signals: any[], existingAssetIds: Set<string>) {
  const derived: any[] = [];
  const seen = new Set<string>();

  for (const signal of signals) {
    if (signal.status === 'dismissed') continue;
    if (signal.verification_status !== 'approved') continue;
    if (SWEDISH_ASSET_IDS.has(signal.matched_asset_id)) continue;
    if (isNoiseMarketQuestion(String(signal.market_title || ''))) continue;
    if (Number(signal.confidence || 0) < 72) continue;
    if (String(signal.primary_source_family || '') === 'crypto_proxy_market') continue;
    if (String(signal.execution_replay_gate || '') === 'block') continue;

    const family = String(signal.primary_source_family || '');
    const direction = String(signal.suggested_action || '').toLowerCase().includes('bull') ? 'bull' : 'bear';
    const haystack = `${signal.market_title || ''} ${signal.catalyst_summary || ''} ${signal.reasoning || ''}`;

    for (const rule of SWEDISH_PROXY_RULES) {
      if (existingAssetIds.has(rule.assetId)) continue;
      if (!rule.families.includes(family)) continue;
      if (!rule.pattern.test(haystack)) continue;

      const dedupKey = `${rule.assetId}:${signal.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      existingAssetIds.add(rule.assetId);

      derived.push({
        ...signal,
        id: `proxy:${rule.assetId}:${signal.id}`,
        matched_asset_id: rule.assetId,
        matched_asset_name: rule.assetName,
        confidence: Math.max(48, Number(signal.confidence || 0) - rule.confidencePenalty),
        suggested_instruments: JSON.stringify(buildProxyInstrument(rule, direction)),
        verification_source: 'catalyst_proxy',
        verification_reason: `${rule.reason} Source: ${signal.matched_asset_name}.`,
        reasoning:
          `${signal.reasoning || ''} [swedish_proxy_from:${signal.matched_asset_id}] ` +
          `[swedish_proxy_reason:${rule.reason}]`,
        proxy: true,
        proxy_source_signal_id: signal.id
      });
      break;
    }
  }

  return derived;
}

// GET /api/signals - Get signals with optional filters
// Query params: limit, status, hours (recency), min_confidence
router.get('/', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const status = req.query.status as any;
    const hours = req.query.hours ? parseInt(req.query.hours as string) : undefined;
    const minConfidence = req.query.min_confidence ? parseInt(req.query.min_confidence as string) : undefined;
    const origin = ['polymarket', 'catalyst_convergence', 'hybrid'].includes(String(req.query.origin || ''))
      ? String(req.query.origin)
      : undefined;

    const signals = (hours !== undefined || minConfidence !== undefined)
      ? services.signalStore.findFiltered({ hours, minConfidence, status, limit })
      : services.signalStore.findAll(limit, status);

    const parsed = signals
      .filter(signal => !origin || signal.signal_origin === origin)
      .filter(signal =>
        !isNoiseMarketQuestion(String(signal.market_title || '')) &&
        isDashboardEligibleSignal(signal)
      )
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
    const origin = ['polymarket', 'catalyst_convergence', 'hybrid'].includes(String(req.query.origin || ''))
      ? String(req.query.origin)
      : undefined;
    const allSignals = services.signalStore.findFiltered({ hours: 72, limit: 1000 });
    const signals = allSignals.filter(s =>
      (!origin || s.signal_origin === origin) &&
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

// Swedish assets — use canonical set from trading-hours.ts (single source of truth)
const SWEDISH_ASSET_IDS = SWEDISH_MARKET_ASSETS;

// GET /api/signals/top/swedish - Top 5 Swedish-asset signals (must be before /:id)
router.get('/top/swedish', (req, res) => {
  try {
    const includeUnverified = req.query.include_unverified === 'true';
    const allRecentSignals = services.signalStore.findFiltered({ hours: 48, limit: 1000 }) as any[];
    const directSignals = (services.signalStore as any).findByAssetIds(
      Array.from(SWEDISH_ASSET_IDS),
      { hours: 48, limit: 1000 }
    ) as any[];
    const swedishPool = directSignals
      .filter((s: any) =>
        s.status !== 'dismissed' &&
        !isNoiseMarketQuestion(String(s.market_title || '')) &&
        isDashboardEligibleSignal(s) &&
        (includeUnverified || isApprovedForSwedishFocus(s)) &&
        SWEDISH_ASSET_IDS.has(s.matched_asset_id)
      )
      .sort((a: any, b: any) => b.confidence - a.confidence);

    const byAsset = new Map<string, any>();
    for (const signal of swedishPool) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    const existingAssetIds = new Set<string>(Array.from(byAsset.keys()));
    const proxySignals = includeUnverified
      ? []
      : buildSwedishProxySignals(
          allRecentSignals
            .filter(signal =>
              !isNoiseMarketQuestion(String(signal.market_title || '')) &&
              isDashboardEligibleSignal(signal)
            )
            .sort((a, b) => b.confidence - a.confidence),
          existingAssetIds
        );

    const combined = [
      ...Array.from(byAsset.values()),
      ...proxySignals
    ]
      .sort((a: any, b: any) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(parseSignal);
    res.json(combined);
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

// GET /api/signals/push-diagnostics - Recent blocked push candidates
router.get('/push-diagnostics', (req, res) => {
  try {
    const rows = services.signalStore.findFiltered({ hours: 24, minConfidence: 45, limit: 200 })
      .filter((row: any) =>
        row.verification_status === 'approved'
      )
      .sort((a: any, b: any) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
      .slice(0, 100);

    const annotated = rows.map((row: any) => {
      const parsedRow = parseSignal(row);
      const reasoning = String(parsedRow.reasoning || '');
      const pushGateOutcome = String((row as any).push_gate_outcome || '').trim();
      const gateKey = pushGateOutcome ? pushGateOutcome.split(':')[0].trim() : 'no_gate_recorded';
      const blocks = [pushGateOutcome || 'no gate outcome recorded'];

      return {
        ...parsedRow,
        push_gate_outcome: pushGateOutcome || null,
        gate_key: gateKey,
        likely_blocks: blocks,
        source_families: (reasoning.match(/\[[^\]]+\]/g) || []).join(' ')
      };
    });

    const summary = {
      total: annotated.length,
      by_origin: {} as Record<string, number>,
      gate_distribution: {} as Record<string, number>
    };

    for (const row of annotated) {
      const origin = String(row.signal_origin || 'polymarket');
      summary.by_origin[origin] = (summary.by_origin[origin] || 0) + 1;
      summary.gate_distribution[row.gate_key] = (summary.gate_distribution[row.gate_key] || 0) + 1;
    }

    res.json({ summary, signals: annotated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch push diagnostics' });
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

    const db = (services as any).db;
    const assetPerf = db ? (db.prepare(`
      SELECT samples, hit_rate_30m, hit_rate_60m, reliability_score, suggested_confidence_adjustment
      FROM asset_performance WHERE asset_id = ? LIMIT 1
    `).get(signal.matched_asset_id) as {
      samples: number; hit_rate_30m: number; hit_rate_60m: number;
      reliability_score: number; suggested_confidence_adjustment: number;
    } | undefined) : undefined;

    const recentOutcomes: Array<{ date: string; direction: string; hit_30m: number; move_30m_pct: number }> = db
      ? (db.prepare(`
          SELECT DATE(so.entry_time) as date,
                 COALESCE(s.suggested_action, 'unknown') as direction,
                 COALESCE(so.direction_correct_30m, 0) as hit_30m,
                 COALESCE(so.move_30m_pct, 0) as move_30m_pct
          FROM signal_outcomes so
          LEFT JOIN signals s ON s.id = so.signal_id
          WHERE so.asset_id = ?
          ORDER BY so.entry_time DESC
          LIMIT 6
        `).all(signal.matched_asset_id) as any[])
      : [];

    const signalCatalysts = (services as any).catalystStore
      ? (services as any).catalystStore.getSignalCatalysts(signal.id)
      : [];

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

${signal.primary_source_family || signal.catalyst_summary ? `
<div class="box">
  <div class="label">Catalyst Context</div>
  <p style="margin:0;line-height:1.6;font-size:0.9rem">
    Primary family: ${escapeHtml(signal.primary_source_family || 'unknown')}<br>
    Catalyst score: ${Number(signal.catalyst_score || 0).toFixed(1)}<br>
    Summary: ${escapeHtml(signal.catalyst_summary || 'No catalyst summary')}<br>
    Replay gate: ${escapeHtml(signal.execution_replay_gate || 'unknown')}
    ${signal.execution_replay_samples ? ` (n=${signal.execution_replay_samples}, exp=${Number(signal.execution_replay_expectancy_pct || 0).toFixed(2)}%)` : ''}
  </p>
  ${signalCatalysts.length > 0 ? `<ul style="margin-top:8px">${signalCatalysts.slice(0, 6).map((row: any) => `<li>${escapeHtml(row.relation)}: ${escapeHtml(row.source_family)} - ${escapeHtml(row.normalized_summary || row.title)}</li>`).join('')}</ul>` : ''}
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

${assetPerf && assetPerf.samples >= 2 ? `
<div class="box">
  <div class="label">Asset Track Record — ${signal.matched_asset_name}</div>
  <p style="margin:0;line-height:1.8;font-size:0.9rem">
    Signals evaluated: ${assetPerf.samples}<br>
    Hit rate 30m: ${(assetPerf.hit_rate_30m * 100).toFixed(0)}%
    &nbsp;|&nbsp; 60m: ${(assetPerf.hit_rate_60m * 100).toFixed(0)}%<br>
    Reliability: ${(assetPerf.reliability_score * 100).toFixed(0)}%
    &nbsp;|&nbsp; Confidence adj: ${assetPerf.suggested_confidence_adjustment > 0 ? '+' : ''}${assetPerf.suggested_confidence_adjustment}
  </p>
  ${recentOutcomes.length > 0 ? `<ul style="margin-top:8px">${recentOutcomes.map(o => {
    const hit = o.hit_30m === 1;
    const chg = o.move_30m_pct ?? 0;
    return `<li>${o.date} ${o.direction} — ${hit ? '✓ hit' : '✗ miss'} (${chg > 0 ? '+' : ''}${chg.toFixed(1)}% at 30m)</li>`;
  }).join('')}</ul>` : ''}
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
      WHERE scraped_at >= datetime('now', '-24 hours')
    `).get() as { cnt: number };

    // Sector patterns from active intelligence memory
    const activeMemoryRows = db.prepare(`
      SELECT category, insight, confidence_boost, affected_assets, expires_at
      FROM intelligence_memory
      WHERE expires_at > datetime('now')
      ORDER BY confidence_boost DESC
      LIMIT 20
    `).all() as Array<{
      category: string; insight: string; confidence_boost: number;
      affected_assets: string; expires_at: string;
    }>;

    const sectorPatterns = activeMemoryRows
      .filter(m => !m.category.includes('-'))
      .map(m => ({
        sector: m.category,
        insight: m.insight,
        boost: m.confidence_boost,
        affected_assets: (() => { try { return JSON.parse(m.affected_assets); } catch { return []; } })(),
        expires_at: m.expires_at
      }));

    const crossSectorPatterns = activeMemoryRows
      .filter(m => m.category.includes('-'))
      .map(m => ({
        sectors: m.category,
        insight: m.insight,
        boost: m.confidence_boost,
        expires_at: m.expires_at
      }));

    // Count signals in last 24h that received an intelligence boost
    const boostedSignalCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM signals s
      WHERE s.timestamp >= datetime('now', '-24 hours')
        AND EXISTS (
          SELECT 1 FROM intelligence_memory im
          WHERE im.expires_at > s.timestamp
            AND im.affected_assets LIKE ('%' || s.matched_asset_id || '%')
        )
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
      },
      sector_patterns: {
        boosted_signals_24h: boostedSignalCount.cnt,
        active_sector_count: sectorPatterns.length,
        active_cross_sector_count: crossSectorPatterns.length,
        sectors: sectorPatterns,
        cross_sector: crossSectorPatterns
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
