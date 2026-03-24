import { Router } from 'express';
import { scanner, IntelligenceEngine } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();
const db = (services as any).db;

type BriefingRow = {
  id: number;
  date: string;
  market: 'swedish' | 'us';
  briefing_generated_at: string | null;
  briefing_text: string | null;
  top_signals: string;
  pushed_at: string | null;
};

const TICKER_MAP: Record<string, string> = {
  'Lockheed Martin': 'LMT',
  'S&P 500': 'SP500',
  'Tesla': 'TSLA',
  'Equinor': 'EQNR',
  'Shell': 'SHEL',
  'ConocoPhillips': 'COP',
  'Exxon Mobil': 'XOM',
  'Ericsson B': 'ERIC',
  'Saab B': 'SAAB',
  'Boliden': 'BOL',
  'SSAB': 'SSAB',
  'Evolution Gaming': 'EVO',
  'H&M': 'HM',
  'NVIDIA': 'NVDA',
  'Palantir Technologies': 'PLTR',
  'Rheinmetall': 'RNMBY',
  'BAE Systems': 'BAESY',
  'Novo Nordisk B': 'NVO',
  'Freeport-McMoRan': 'FCX',
  'CrowdStrike Holdings': 'CRWD',
  'Vestas': 'VWDRY',
  'Coinbase Global': 'COIN',
  'Sprott Physical Uranium Trust': 'SRUUF',
  'ZIM Integrated Shipping Services': 'ZIM',
  'Volvo Group': 'VOLVO',
  'Spotify Technology': 'SPOT'
};

function escapeHtml(value: unknown): string {
  const text = `${value ?? ''}`;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getIntelligenceEngine(): IntelligenceEngine {
  return new IntelligenceEngine((services as any).db);
}

function parseTopSignals(value: string | null | undefined): Array<any> {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getBriefingRow(market: 'swedish' | 'us', date?: string): BriefingRow | null {
  if (date) {
    return db.prepare(
      'SELECT * FROM daily_briefing WHERE market = ? AND date = ? LIMIT 1'
    ).get(market, date) as BriefingRow | null;
  }

  return getIntelligenceEngine().getMorningBriefing(market) as BriefingRow | null;
}

router.get('/recent', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(30, parseInt(String(req.query.limit || '12'), 10)));
    const marketFilter = String(req.query.market || '').toLowerCase();
    const rows = marketFilter === 'swedish' || marketFilter === 'us'
      ? db.prepare(`
          SELECT * FROM daily_briefing
          WHERE market = ?
          ORDER BY date DESC, market ASC
          LIMIT ?
        `).all(marketFilter, limit) as BriefingRow[]
      : db.prepare(`
          SELECT * FROM daily_briefing
          ORDER BY date DESC, market ASC
          LIMIT ?
        `).all(limit) as BriefingRow[];

    return res.json(rows.map(row => {
      const topSignals = parseTopSignals(row.top_signals);
      return {
        id: row.id,
        date: row.date,
        market: row.market,
        briefing_generated_at: row.briefing_generated_at,
        pushed_at: row.pushed_at,
        briefing_text: row.briefing_text || '',
        signal_count: topSignals.length,
        top_assets: topSignals
          .slice(0, 3)
          .map((signal: any) => String(signal?.matched_asset_name || '').trim())
          .filter(Boolean),
        url: `/api/briefing/${row.market}?date=${encodeURIComponent(row.date)}`
      };
    }));
  } catch (error) {
    console.error('Briefing recent route error:', error);
    return res.status(500).json({ error: 'Failed to load briefing history' });
  }
});

// GET /api/briefing/:market - HTML morning briefing page
router.get('/:market', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).send('<h1>Market must be "swedish" or "us"</h1>');
    }

    const requestedDate = typeof req.query.date === 'string' ? req.query.date : undefined;
    const briefing = getBriefingRow(market, requestedDate);

    const flag = market === 'swedish' ? '🇸🇪' : '🇺🇸';
    const marketName = market === 'swedish' ? 'OMX Stockholm' : 'US NYSE/NASDAQ';
    const displayDate = requestedDate || new Date().toLocaleDateString('en-CA', {
      timeZone: 'Europe/Stockholm'
    });
    const today = new Date(`${displayDate}T12:00:00Z`).toLocaleDateString('en-SE', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'Europe/Stockholm'
    });

    let signalRows = '';
    let briefingText = 'No briefing has been generated for today yet.';

    if (briefing) {
      briefingText = briefing.briefing_text || 'No briefing text generated.';
      const topSignals = parseTopSignals(briefing.top_signals);

      signalRows = topSignals.map((signal, index) => {
        const isBull = `${signal.suggested_action || ''}`.toLowerCase().includes('bull');
        const direction = isBull ? 'BULL' : 'BEAR';
        const emoji = isBull ? '📈' : '📉';
        const color = isBull ? '#00ff88' : '#ff3d6e';
        const ticker = TICKER_MAP[signal.matched_asset_name] || signal.matched_asset_name || '?';
        const deltaSign = Number(signal.delta_pct) > 0 ? '+' : '';
        const oddsLine = signal.odds_before != null
          ? `${(Number(signal.odds_before) * 100).toFixed(0)}%->${(Number(signal.odds_now) * 100).toFixed(0)}% (${deltaSign}${Number(signal.delta_pct).toFixed(0)}%)`
          : '';

        const detailLink = signal.id ? `/api/signals/${encodeURIComponent(signal.id)}/detail` : '#';

        const instruments = (() => {
          try {
            const parsed = typeof signal.suggested_instruments === 'string'
              ? JSON.parse(signal.suggested_instruments)
              : signal.suggested_instruments;

            if (!Array.isArray(parsed) || parsed.length === 0) {
              return `${direction} ${escapeHtml(ticker)} (search Avanza)`;
            }

            return parsed.map((instrument: any) => {
              const name = escapeHtml(instrument?.name || 'Instrument');
              const url = instrument?.avanza_url;
              if (typeof url === 'string' && url.startsWith('http')) {
                return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#4fc3f7">${name}</a>`;
              }
              return name;
            }).join(' · ');
          } catch {
            return `${direction} ${escapeHtml(ticker)} (search Avanza)`;
          }
        })();

        return `
          <div class="signal-card" style="border-left: 3px solid ${color}">
            <div class="signal-header">
              <span style="color:${color};font-weight:bold">${emoji} #${index + 1} ${direction} ${escapeHtml(ticker)}</span>
              <span class="confidence">${escapeHtml(signal.confidence ?? '?')}%</span>
            </div>
            <div class="signal-title">${escapeHtml(`${signal.market_title || ''}`.substring(0, 96))}</div>
            <div class="signal-odds">${escapeHtml(oddsLine)}</div>
            <div class="signal-instruments">${instruments}</div>
            <a href="${detailLink}" class="detail-link">View details -></a>
          </div>
        `;
      }).join('');
    }

    const intelligence = getIntelligenceEngine();
    const memories = intelligence.getActiveMemories().slice(0, 5);
    const memoryHtml = memories.length > 0
      ? memories.map(memory => {
        const insight = escapeHtml(memory.insight);
        const expires = escapeHtml(`${memory.expires_at || ''}`.substring(0, 10));
        return `<li>Idea: ${insight} <span style="color:#888">(+${memory.confidence_boost} boost, expires ${expires})</span></li>`;
      }).join('')
      : '<li style="color:#666">No active intelligence memories</li>';

    const generatedAt = briefing?.briefing_generated_at
      ? new Date(`${briefing.briefing_generated_at}Z`).toLocaleTimeString('en-SE', { timeZone: 'Europe/Stockholm' })
      : 'N/A';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${flag} ${marketName} Morning Brief</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d1a; color: #e2e2ee; margin: 0; padding: 20px; max-width: 760px; }
  h1 { font-size: 1.4rem; margin-bottom: 2px; }
  .date { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
  .briefing-text { background: #161625; border: 1px solid #2a2a3e; border-radius: 10px; padding: 16px; margin-bottom: 20px; line-height: 1.6; font-size: 0.92rem; white-space: pre-wrap; }
  .signal-card { background: #161625; border: 1px solid #2a2a3e; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .signal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .confidence { background: #2a2a3e; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-family: monospace; }
  .signal-title { font-size: 0.85rem; color: #aaa; margin-bottom: 4px; }
  .signal-odds { font-family: monospace; font-size: 0.85rem; color: #ccc; margin-bottom: 6px; }
  .signal-instruments { font-size: 0.82rem; color: #888; margin-bottom: 8px; }
  .detail-link { font-size: 0.8rem; color: #4fc3f7; text-decoration: none; }
  .section-title { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.08em; margin: 24px 0 8px; }
  .memory-list { padding-left: 0; list-style: none; }
  .memory-list li { background: #161625; border: 1px solid #2a2a3e; border-radius: 6px; padding: 10px; margin-bottom: 6px; font-size: 0.85rem; }
  .footer { color: #444; font-size: 0.75rem; margin-top: 32px; }
  a { color: #4fc3f7; }
</style>
</head>
<body>
<h1>${flag} ${marketName} Morning Brief</h1>
<div class="date">${today} · Generated ${generatedAt}</div>

<div class="briefing-text">${escapeHtml(briefingText)}</div>

${signalRows ? `<div class="section-title">Top Signals</div>${signalRows}` : ''}

<div class="section-title">Active Intelligence</div>
<ul class="memory-list">${memoryHtml}</ul>

<div class="footer">
  <a href="/api/signals/top">All Top Signals</a> ·
  <a href="/api/health">System Health</a> ·
  PolySignal v1.0
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    return res.send(html);
  } catch (error) {
    console.error('Briefing route error:', error);
    return res.status(500).send('<h1>Error loading briefing</h1><p>Check API server logs.</p>');
  }
});

// POST /api/briefing/:market/generate - Trigger briefing generation
router.post('/:market/generate', async (req, res) => {
  try {
    const market = req.params.market as 'swedish' | 'us';
    if (market !== 'swedish' && market !== 'us') {
      return res.status(400).json({ error: 'Market must be "swedish" or "us"' });
    }

    const intelligence = getIntelligenceEngine();
    const text = await intelligence.generateMorningBriefing(market);
    return res.json({ market, briefing: text });
  } catch {
    return res.status(500).json({ error: 'Failed to generate briefing' });
  }
});

export default router;
