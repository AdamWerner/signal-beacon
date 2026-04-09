import { createHash } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ASSET_TO_TICKER, getAssetDisplayName, getAssetTicker } from '../utils/ticker-map.js';
import { SourceCatalyst } from './types.js';
import { parseDbTimestampMs } from '../utils/time.js';

const FOREX_FACTORY_FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MS = 15 * 60 * 1000;
const RELEASE_LOOKBACK_MS = 15 * 60 * 1000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MACRO_CALENDAR_PATH = path.resolve(MODULE_DIR, '../../../../data/macro-calendar.json');

interface MacroCalendarEntry {
  name: string;
  schedule: string;
  impact: 'medium' | 'high' | 'very_high';
  affected_assets: string[];
  direction_hint?: string;
  pre_drift_minutes: number;
  elevated_vol_minutes: number;
}

interface ForexFactoryEvent {
  title: string;
  country?: string;
  date: string;
  impact?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

interface SurpriseMapping {
  eventName: string;
  affectedAssets: string[];
  direction: 'bull' | 'bear' | 'neutral';
  body: string;
  sourceWeight: number;
}

interface CachedEconScan {
  expiresAt: number;
  catalysts: SourceCatalyst[];
}

function hashValue(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeImpact(impact?: string): 'low' | 'medium' | 'high' {
  const lowered = String(impact || '').toLowerCase();
  if (lowered.includes('high')) return 'high';
  if (lowered.includes('medium')) return 'medium';
  return 'low';
}

function parseCalendarResponse(raw: string): ForexFactoryEvent[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as ForexFactoryEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseNumericValue(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value
    .replace(/<[^>]+>/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .replace(/−/g, '-')
    .replace(/[^\d.+\-KMBT%]/gi, '')
    .toUpperCase();
  if (!normalized) return null;

  const multiplier = normalized.endsWith('T')
    ? 1_000_000_000_000
    : normalized.endsWith('B')
      ? 1_000_000_000
      : normalized.endsWith('M')
        ? 1_000_000
        : normalized.endsWith('K')
          ? 1_000
          : 1;
  const numeric = parseFloat(normalized.replace(/[KMBT%]$/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return numeric * multiplier;
}

export class EconCalendarScanner {
  private cache: CachedEconScan | null = null;
  private readonly macroEntries: MacroCalendarEntry[];

  constructor(private db?: Database.Database) {
    this.macroEntries = this.loadMacroEntries();
  }

  async scan(): Promise<SourceCatalyst[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.catalysts;
    }

    try {
      const response = await fetch(FOREX_FACTORY_FEED, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PolySignal/1.0)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        if (response.status !== 429) {
          console.warn(`[econ] calendar feed returned ${response.status}`);
        }
        this.cache = { expiresAt: Date.now() + CACHE_TTL_MS, catalysts: [] };
        return [];
      }

      const raw = await response.text();
      const events = parseCalendarResponse(raw);
      const catalysts = this.extractCatalysts(events);
      this.cache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        catalysts
      };
      return catalysts;
    } catch (error) {
      console.warn(`[econ] surprise scan failed: ${String(error)}`);
      this.cache = { expiresAt: Date.now() + CACHE_TTL_MS, catalysts: [] };
      return [];
    }
  }

  private extractCatalysts(events: ForexFactoryEvent[]): SourceCatalyst[] {
    const catalysts: SourceCatalyst[] = [];
    const now = Date.now();

    for (const event of events) {
      const eventTime = parseDbTimestampMs(event.date);
      if (!Number.isFinite(eventTime)) continue;
      if (Math.abs(now - eventTime) > RELEASE_LOOKBACK_MS) continue;

      const actualValue = parseNumericValue(event.actual);
      const forecastValue = parseNumericValue(event.forecast);
      if (actualValue === null || forecastValue === null) continue;

      const mapping = this.mapSurprise(event, actualValue, forecastValue);
      if (!mapping || mapping.direction === 'neutral' || mapping.affectedAssets.length === 0) continue;

      const urgency = normalizeImpact(event.impact) === 'high' ? 'high' : 'medium';
      const magnitude = Math.abs(actualValue - forecastValue);
      const surprisePct = forecastValue === 0 ? magnitude : Math.abs((actualValue - forecastValue) / forecastValue) * 100;

      for (const assetId of mapping.affectedAssets) {
        const ticker = getAssetTicker(assetId) || ASSET_TO_TICKER[assetId] || (event.country || 'MACRO');
        const assetName = getAssetDisplayName(assetId);
        const timestamp = new Date(eventTime).toISOString();
        const title = `${mapping.eventName} surprise (${event.country || 'macro'})`;
        const catalyst: SourceCatalyst = {
          sourceType: 'econ_surprise',
          sourceKey: `econ:${assetId}:${hashValue(`${event.title}:${event.date}:${event.actual}:${event.forecast}`)}`,
          ticker,
          assetId,
          assetName,
          title,
          body: mapping.body,
          directionHint: mapping.direction,
          urgency,
          timestamp,
          sourceWeight: clamp(mapping.sourceWeight + (surprisePct / 200), 1, 1.5),
          metadata: {
            eventTitle: event.title,
            impact: event.impact || 'Unknown',
            actual: event.actual || null,
            forecast: event.forecast || null,
            previous: event.previous || null,
            surprisePct: Number(surprisePct.toFixed(2))
          }
        };
        catalysts.push(catalyst);
        this.persistSurprise(event, assetId, mapping.direction, actualValue, forecastValue, surprisePct);
      }
    }

    return catalysts;
  }

  private mapSurprise(
    event: ForexFactoryEvent,
    actualValue: number,
    forecastValue: number
  ): SurpriseMapping | null {
    const title = event.title.toLowerCase();
    const delta = actualValue - forecastValue;

    if (event.country === 'USD' && /cpi|inflation/i.test(title) && Math.abs(delta) >= 0.2) {
      const entry = this.findEntry('US CPI');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta > 0 ? 'bull' : 'bear';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `US CPI surprised ${delta > 0 ? 'hotter' : 'cooler'} than expected (${event.actual} vs ${event.forecast})`,
        sourceWeight: entry.impact === 'very_high' ? 1.3 : 1.18
      };
    }

    if (event.country === 'USD' && (/non-farm|nfp/i.test(title) || title.includes('employment change')) && Math.abs(delta) >= 50_000) {
      const entry = this.findEntry('US Non-Farm Payrolls');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta > 0 ? 'bull' : 'bear';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `US jobs surprised ${delta > 0 ? 'stronger' : 'weaker'} than expected (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.2
      };
    }

    if (event.country === 'USD' && /fomc|federal funds|interest rate/i.test(title) && Math.abs(delta) >= 0.1) {
      const entry = this.findEntry('FOMC Rate Decision');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta > 0 ? 'bear' : 'bull';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `FOMC outcome diverged from expectation (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.28
      };
    }

    if (event.country === 'USD' && /ppi/i.test(title) && Math.abs(delta) >= 0.2) {
      const entry = this.findEntry('US PPI');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta > 0 ? 'bull' : 'bear';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `US producer prices came in ${delta > 0 ? 'hotter' : 'cooler'} than forecast (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.12
      };
    }

    if ((event.country === 'USD' || event.country === 'CAD') && /crude oil|oil inventories|eia/i.test(title) && Math.abs(delta) >= 0.5) {
      const oilAssets = this.findEntry('OPEC Meeting')?.affected_assets || ['oil-equinor', 'oil-shell', 'oil-exxon', 'oil-conocophillips'];
      const direction: SurpriseMapping['direction'] = actualValue < forecastValue ? 'bull' : 'bear';
      return {
        eventName: 'Oil Inventory Surprise',
        affectedAssets: oilAssets,
        direction,
        body: `Oil inventory data surprised the market (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.16
      };
    }

    if (event.country === 'SEK' && /riksbank|policy rate|repo rate/i.test(title) && Math.abs(delta) >= 0.1) {
      const entry = this.findEntry('Swedish Riksbank Rate Decision');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta < 0 ? 'bull' : 'bear';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `Riksbank decision surprised the market (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.2
      };
    }

    if (event.country === 'EUR' && /ecb|main refinancing|deposit facility|interest rate/i.test(title) && Math.abs(delta) >= 0.1) {
      const entry = this.findEntry('ECB Rate Decision');
      if (!entry) return null;
      const direction: SurpriseMapping['direction'] = delta < 0 ? 'bull' : 'bear';
      return {
        eventName: entry.name,
        affectedAssets: entry.affected_assets,
        direction,
        body: `ECB decision diverged from forecast (${event.actual} vs ${event.forecast})`,
        sourceWeight: 1.18
      };
    }

    return null;
  }

  private persistSurprise(
    event: ForexFactoryEvent,
    assetId: string,
    directionHint: 'bull' | 'bear' | 'neutral',
    actualValue: number,
    forecastValue: number,
    surprisePct: number
  ): void {
    if (!this.db) return;

    try {
      this.db.prepare(`
        INSERT INTO econ_surprises (
          event_name, event_time, currency, impact, expected, actual, surprise_pct, affected_assets, direction_hint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.title,
        new Date(event.date).toISOString(),
        event.country || null,
        event.impact || null,
        forecastValue,
        actualValue,
        Number(surprisePct.toFixed(2)),
        JSON.stringify([assetId]),
        directionHint
      );
    } catch (error) {
      if (!/econ_surprises/i.test(String(error))) {
        console.warn(`[econ] surprise persistence failed for ${event.title}: ${String(error)}`);
      }
    }
  }

  private findEntry(name: string): MacroCalendarEntry | undefined {
    return this.macroEntries.find(entry => entry.name === name);
  }

  private loadMacroEntries(): MacroCalendarEntry[] {
    try {
      const raw = fs.readFileSync(MACRO_CALENDAR_PATH, 'utf8');
      const parsed = JSON.parse(raw) as MacroCalendarEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn(`[econ] failed to load macro-calendar.json at ${MACRO_CALENDAR_PATH}:`, error);
      return [];
    }
  }
}
