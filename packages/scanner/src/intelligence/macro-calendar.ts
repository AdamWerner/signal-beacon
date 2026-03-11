import fs from 'node:fs';
import path from 'node:path';

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
    const filePath = path.resolve(process.cwd(), 'data', 'macro-calendar.json');
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as MacroCalendarEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn('[macro] failed to load macro-calendar.json:', error);
      return [];
    }
  }

  private computeNextOccurrence(entry: MacroCalendarEntry, from: Date): Date | null {
    const name = entry.name.toLowerCase();
    if (name.includes('us cpi')) {
      return this.nextMonthlyDay(from, 13, 14, 30);
    }

    if (name.includes('us ppi')) {
      return this.nextMonthlyDay(from, 14, 14, 30);
    }

    if (name.includes('non-farm payroll')) {
      return this.nextFirstWeekdayOfMonth(from, 5, 14, 30); // Friday
    }

    if (name.includes('fomc')) {
      return this.nextApproximatePolicyDay(from, [1, 3, 5, 6, 7, 9, 11, 12], 3, 20, 0); // Wed
    }

    if (name.includes('ecb')) {
      return this.nextApproximatePolicyDay(from, [1, 3, 4, 6, 7, 9, 10, 12], 4, 14, 15); // Thu
    }

    if (name.includes('riksbank')) {
      return this.nextApproximatePolicyDay(from, [2, 3, 5, 6, 8, 9, 11, 12], 4, 9, 30); // Thu
    }

    if (name.includes('opec')) {
      return this.nextApproximatePolicyDay(from, [3, 6, 9, 12], 3, 14, 0); // Quarterly-ish
    }

    return null;
  }

  private nextMonthlyDay(from: Date, day: number, hour: number, minute: number): Date {
    let year = from.getFullYear();
    let month = from.getMonth();
    let candidate = new Date(year, month, day, hour, minute, 0, 0);
    if (candidate.getTime() <= from.getTime()) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      candidate = new Date(year, month, day, hour, minute, 0, 0);
    }
    return candidate;
  }

  private nextFirstWeekdayOfMonth(
    from: Date,
    weekday: number,
    hour: number,
    minute: number
  ): Date {
    let year = from.getFullYear();
    let month = from.getMonth();
    for (let i = 0; i < 14; i++) {
      const candidate = this.firstWeekdayOfMonth(year, month, weekday, hour, minute);
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
    minute: number
  ): Date {
    const date = new Date(year, month, 1, hour, minute, 0, 0);
    while (date.getDay() !== weekday) {
      date.setDate(date.getDate() + 1);
    }
    return date;
  }

  private nextApproximatePolicyDay(
    from: Date,
    months: number[],
    weekday: number,
    hour: number,
    minute: number
  ): Date {
    const normalizedMonths = new Set(months.map(m => m - 1));
    let year = from.getFullYear();
    let month = from.getMonth();
    for (let i = 0; i < 24; i++) {
      if (normalizedMonths.has(month)) {
        const candidate = this.firstWeekdayOfMonth(year, month, weekday, hour, minute);
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
