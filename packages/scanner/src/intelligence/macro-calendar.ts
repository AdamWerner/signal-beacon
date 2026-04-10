import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MACRO_CALENDAR_PATH = path.resolve(MODULE_DIR, '../../../../data/macro-calendar.json');

function normalizeTimeZone(tz: string): string {
  switch (tz) {
    case 'Europe/Frankfurt':
      return 'Europe/Berlin';
    default:
      return tz;
  }
}

function getZonedParts(date: Date, tz: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false
  }).formatToParts(date);
}

function getPart(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find(part => part.type === type)?.value ?? '';
}

/**
 * Build a UTC epoch ms for a given calendar date at a given wall-clock
 * time IN a named IANA timezone. Uses an Intl-based inverse lookup
 * (build a Date in a test UTC, check how the target TZ formats it,
 * compute offset, invert).
 */
function buildInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): Date {
  try {
    const normalizedTz = normalizeTimeZone(tz);
    // Build a candidate UTC epoch assuming the target time is UTC, then
    // measure the offset by formatting that epoch in the target TZ and
    // computing the difference.
    const candidateUtcMs = Date.UTC(year, month, day, hour, minute, 0, 0);

    // Format the candidate in the target timezone to read back the wall time
    const parts = getZonedParts(new Date(candidateUtcMs), normalizedTz);
    const tzYear = parseInt(getPart(parts, 'year') || '0', 10);
    const tzMonth = parseInt(getPart(parts, 'month') || '0', 10) - 1; // month is 1-based in formatToParts
    const tzDay = parseInt(getPart(parts, 'day') || '0', 10);
    const tzHour = parseInt(getPart(parts, 'hour') || '0', 10);
    const tzMinute = parseInt(getPart(parts, 'minute') || '0', 10);
    const tzSecond = parseInt(getPart(parts, 'second') || '0', 10);

    // Difference in ms between what the TZ shows and what we want
    const tzShownUtcMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond);
    const targetUtcMs = Date.UTC(year, month, day, hour, minute, 0, 0);
    const offsetMs = tzShownUtcMs - targetUtcMs;

    return new Date(candidateUtcMs - offsetMs);
  } catch (err) {
    console.warn(`[macro] buildInZone(${year},${month},${day},${hour}:${minute},${tz}) failed:`, err);
    // Fallback: local-time Date (preserves old behavior with a warning)
    return new Date(year, month, day, hour, minute, 0, 0);
  }
}

function getWeekdayInZone(date: Date, tz: string): number {
  const weekday = getPart(getZonedParts(date, tz), 'weekday');
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return weekdayMap[weekday] ?? date.getUTCDay();
}

export interface MacroCalendarEntry {
  name: string;
  schedule: string;
  impact: 'medium' | 'high' | 'very_high';
  affected_assets: string[];
  direction_hint?: string;
  pre_drift_minutes: number;
  elevated_vol_minutes: number;
}

export interface MacroEvent extends MacroCalendarEntry {
  eventTime: Date;
  source: 'static' | 'rss';
}

export interface MacroEventWindow {
  inWindow: boolean;
  eventName: string;
  minutesUntil: number;
  impact: string;
}

export class MacroCalendar {
  private readonly entries: MacroCalendarEntry[];
  private dynamicEvents: MacroEvent[] = [];
  private lastRefreshAt = 0;

  constructor() {
    this.entries = this.loadCalendar();
  }

  async refreshLiveEvents(): Promise<void> {
    if (Date.now() - this.lastRefreshAt < 15 * 60 * 1000) {
      return;
    }

    this.lastRefreshAt = Date.now();
    try {
      this.dynamicEvents = await this.fetchRssEvents();
    } catch (error) {
      console.warn('[macro] live event refresh failed:', error);
      this.dynamicEvents = [];
    }
  }

  getUpcomingEvents(hoursAhead: number): MacroEvent[] {
    const now = new Date();
    const horizon = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const staticEvents: MacroEvent[] = [];
    for (const entry of this.entries) {
      const eventTime = this.computeNextOccurrence(entry, now);
      if (!eventTime || eventTime > horizon) {
        continue;
      }
      staticEvents.push({
        ...entry,
        eventTime,
        source: 'static'
      });
    }

    const rssEvents = this.dynamicEvents.filter(event => event.eventTime <= horizon);
    const combined = [...staticEvents, ...rssEvents];
    combined.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());

    return combined;
  }

  isInEventWindow(assetId: string): MacroEventWindow {
    const now = new Date();
    const events = this.getUpcomingEvents(24).filter(event => event.affected_assets.includes(assetId));
    if (events.length === 0) {
      return { inWindow: false, eventName: '', minutesUntil: 0, impact: '' };
    }

    let winner: { event: MacroEvent; minutesUntil: number } | null = null;

    for (const event of events) {
      const minutesUntil = Math.round((event.eventTime.getTime() - now.getTime()) / 60000);
      const inPreDrift = minutesUntil >= 0 && minutesUntil <= event.pre_drift_minutes;
      const inElevatedVol = minutesUntil < 0 && Math.abs(minutesUntil) <= event.elevated_vol_minutes;
      if (!inPreDrift && !inElevatedVol) {
        continue;
      }

      if (!winner || Math.abs(minutesUntil) < Math.abs(winner.minutesUntil)) {
        winner = { event, minutesUntil };
      }
    }

    if (!winner) {
      return { inWindow: false, eventName: '', minutesUntil: 0, impact: '' };
    }

    return {
      inWindow: true,
      eventName: winner.event.name,
      minutesUntil: winner.minutesUntil,
      impact: winner.event.impact
    };
  }

  private loadCalendar(): MacroCalendarEntry[] {
    try {
      const raw = fs.readFileSync(MACRO_CALENDAR_PATH, 'utf8');
      const parsed = JSON.parse(raw) as MacroCalendarEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn(`[macro] failed to load macro-calendar.json at ${MACRO_CALENDAR_PATH}:`, error);
      return [];
    }
  }

  private computeNextOccurrence(entry: MacroCalendarEntry, from: Date): Date | null {
    const name = entry.name.toLowerCase();
    if (name.includes('us cpi')) {
      return this.nextMonthlyDay(from, 13, 8, 30, 'America/New_York');
    }

    if (name.includes('us ppi')) {
      return this.nextMonthlyDay(from, 14, 8, 30, 'America/New_York');
    }

    if (name.includes('non-farm payroll')) {
      return this.nextFirstWeekdayOfMonth(from, 5, 8, 30, 'America/New_York'); // Friday 8:30 ET
    }

    if (name.includes('fomc')) {
      return this.nextApproximatePolicyDay(from, [1, 3, 5, 6, 7, 9, 11, 12], 3, 14, 0, 'America/New_York'); // Wed 14:00 ET
    }

    if (name.includes('ecb')) {
      return this.nextApproximatePolicyDay(from, [1, 3, 4, 6, 7, 9, 10, 12], 4, 14, 15, 'Europe/Frankfurt'); // Thu 14:15 CET
    }

    if (name.includes('riksbank')) {
      return this.nextApproximatePolicyDay(from, [2, 3, 5, 6, 8, 9, 11, 12], 4, 9, 30, 'Europe/Stockholm'); // Thu 09:30 CET
    }

    if (name.includes('opec')) {
      return this.nextApproximatePolicyDay(from, [3, 6, 9, 12], 3, 14, 0, 'Europe/Vienna'); // Quarterly-ish, Vienna
    }

    return null;
  }

  private nextMonthlyDay(
    from: Date,
    day: number,
    hour: number,
    minute: number,
    tz = 'America/New_York'
  ): Date {
    let year = from.getFullYear();
    let month = from.getMonth();
    let candidate = buildInZone(year, month, day, hour, minute, tz);
    if (candidate.getTime() <= from.getTime()) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      candidate = buildInZone(year, month, day, hour, minute, tz);
    }
    return candidate;
  }

  private nextFirstWeekdayOfMonth(
    from: Date,
    weekday: number,
    hour: number,
    minute: number,
    tz = 'America/New_York'
  ): Date {
    let year = from.getFullYear();
    let month = from.getMonth();
    for (let i = 0; i < 14; i++) {
      const candidate = this.firstWeekdayOfMonth(year, month, weekday, hour, minute, tz);
      if (candidate.getTime() > from.getTime()) {
        return candidate;
      }
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  private firstWeekdayOfMonth(
    year: number,
    month: number,
    weekday: number,
    hour: number,
    minute: number,
    tz = 'America/New_York'
  ): Date {
    // Start from the 1st; we need the wall-clock day in the target TZ,
    // so iterate over UTC epoch values that correspond to that TZ day.
    let dayOfMonth = 1;
    while (dayOfMonth <= 7) {
      const candidate = buildInZone(year, month, dayOfMonth, hour, minute, tz);
      if (getWeekdayInZone(candidate, tz) === weekday) {
        return candidate;
      }
      dayOfMonth += 1;
    }
    // Fallback: shouldn't happen
    return buildInZone(year, month, 1, hour, minute, tz);
  }

  private nextApproximatePolicyDay(
    from: Date,
    months: number[],
    weekday: number,
    hour: number,
    minute: number,
    tz = 'America/New_York'
  ): Date {
    const normalizedMonths = new Set(months.map(m => m - 1));
    let year = from.getFullYear();
    let month = from.getMonth();
    for (let i = 0; i < 24; i++) {
      if (normalizedMonths.has(month)) {
        const candidate = this.firstWeekdayOfMonth(year, month, weekday, hour, minute, tz);
        if (candidate.getTime() > from.getTime()) {
          return candidate;
        }
      }

      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return new Date(from.getTime() + 60 * 24 * 60 * 60 * 1000);
  }

  private async fetchRssEvents(): Promise<MacroEvent[]> {
    const now = new Date();
    const queries: Array<{ name: string; query: string }> = [
      { name: 'US CPI', query: 'US CPI release time' },
      { name: 'US Non-Farm Payrolls', query: 'US nonfarm payrolls release time' },
      { name: 'FOMC Rate Decision', query: 'FOMC rate decision today time' },
      { name: 'ECB Rate Decision', query: 'ECB rate decision today time' },
      { name: 'US PPI', query: 'US PPI release time' },
      { name: 'OPEC Meeting', query: 'OPEC meeting today' },
      { name: 'Swedish Riksbank Rate Decision', query: 'Riksbank rate decision today' }
    ];

    const byName = new Map(this.entries.map(entry => [entry.name, entry]));
    const events: MacroEvent[] = [];

    for (const source of queries) {
      const entry = byName.get(source.name);
      if (!entry) continue;

      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(source.query)}&hl=en-US&gl=US&ceid=US:en`;
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'PolySignal/1.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) continue;

        const xml = await response.text();
        const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
        const hasRecentCoverage = itemMatches.some(match => {
          const block = match[1];
          const dateMatch = block.match(/<pubDate>(.*?)<\/pubDate>/i);
          if (!dateMatch) return false;
          const published = new Date(dateMatch[1]);
          if (Number.isNaN(published.getTime())) return false;
          const ageMs = now.getTime() - published.getTime();
          return ageMs >= 0 && ageMs <= 18 * 60 * 60 * 1000;
        });

        if (!hasRecentCoverage) continue;

        events.push({
          ...entry,
          source: 'rss',
          eventTime: new Date(now.getTime() + Math.min(entry.pre_drift_minutes, 30) * 60000)
        });
      } catch {
        // Keep static calendar fallback if RSS fails.
      }
    }

    return events;
  }
}
