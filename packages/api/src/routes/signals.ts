import { Router } from 'express';
import { scanner, getTopSignals, analyzeSignal, IntelligenceEngine } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();

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

    const parsed = signals.map(signal => ({
      ...signal,
      suggested_instruments: JSON.parse(signal.suggested_instruments)
    }));

    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// GET /api/signals/top - AI-ranked top 10 signals (must be before /:id)
router.get('/top', async (req, res) => {
  try {
    const allSignals = services.signalStore.findAll(500);
    const signals = allSignals.filter(s => s.status !== 'dismissed');
    // Dedup + AI ranking handled inside getTopSignals
    const top = await getTopSignals(signals);
    const parsed = top.map(signal => ({
      ...signal,
      suggested_instruments: JSON.parse(signal.suggested_instruments as unknown as string),
      also_affects: (signal as any).also_affects ?? []
    }));
    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch top signals' });
  }
});

// Swedish assets
const SWEDISH_ASSET_IDS = new Set(['defense-saab', 'steel-ssab', 'mining-boliden', 'telecom-ericsson', 'gaming-evolution', 'retail-hm', 'auto-volvo', 'tech-spotify']);
const SWEDISH_NAME_FRAGMENTS = ['saab', 'ssab', 'boliden', 'ericsson', 'evolution', 'h&m', 'hennes', 'volvo', 'spotify'];

// GET /api/signals/top/swedish - Top 5 Swedish-asset signals (must be before /:id)
router.get('/top/swedish', (req, res) => {
  try {
    const signals = services.signalStore.findFiltered({ hours: 48, limit: 500 });
    const swedish = signals
      .filter(s =>
        s.status !== 'dismissed' &&
        (SWEDISH_ASSET_IDS.has(s.matched_asset_id) ||
        SWEDISH_NAME_FRAGMENTS.some(f => s.matched_asset_name.toLowerCase().includes(f)))
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(s => ({ ...s, suggested_instruments: JSON.parse(s.suggested_instruments) }));
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

    const instruments = JSON.parse(signal.suggested_instruments);
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

    const polyUrl = signal.market_slug
      ? `https://polymarket.com/event/${signal.market_slug}`
      : `https://polymarket.com/search?q=${encodeURIComponent(signal.market_title.substring(0, 50))}`;

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

    res.json({
      ...signal,
      suggested_instruments: JSON.parse(signal.suggested_instruments)
    });
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

// GET /api/briefing/:market - Today's morning briefing
router.get('/briefing/:market', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).json({ error: 'Market must be "swedish" or "us"' });
    }
    const intel = new IntelligenceEngine((services as any).db);
    const briefing = intel.getMorningBriefing(market);
    if (briefing) {
      res.json({ ...briefing, top_signals: JSON.parse(briefing.top_signals || '[]') });
    } else {
      res.json({ message: 'No briefing generated yet today', market });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch briefing' });
  }
});

// POST /api/briefing/:market/generate - Trigger briefing generation
router.post('/briefing/:market/generate', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).json({ error: 'Market must be "swedish" or "us"' });
    }
    const intel = new IntelligenceEngine((services as any).db);
    const text = await intel.generateMorningBriefing(market);
    res.json({ market, briefing: text });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate briefing' });
  }
});

// GET /api/intelligence/memory - Active intelligence memories
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
