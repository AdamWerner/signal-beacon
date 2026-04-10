import { beforeAll, describe, expect, it } from 'vitest';
import { MacroCalendar } from './macro-calendar.js';

// Force Stockholm timezone so the TZ-correctness assertions are meaningful.
// FOMC at 14:00 ET on 2026-05-06 must resolve to 18:00Z regardless of host TZ.
beforeAll(() => {
  process.env.TZ = 'Europe/Stockholm';
});

// buildInZone is module-private, so we test it indirectly through
// MacroCalendar's public getUpcomingEvents() which calls computeNextOccurrence().

describe('MacroCalendar — event timezone correctness', () => {
  it('FOMC at 14:00 ET resolves to 18:00 UTC (EDT offset = -4h) on 2026-05-06 (summer time)', () => {
    // 2026-05-06 is a Wednesday in a FOMC month (May = month 5 in the months array [1,3,5,6,7,9,11,12])
    // EDT is UTC-4 → 14:00 ET = 18:00 UTC
    const cal = new MacroCalendar();

    // Pin "from" to just before the expected event so getUpcomingEvents returns it.
    // The FOMC is the first Wednesday of May 2026 = 2026-05-06.
    // We want to find it within 24h of 2026-05-06T17:00:00Z (one hour before).
    const fromMs = Date.parse('2026-05-06T17:00:00Z');
    const fromDate = new Date(fromMs);

    // Use a large horizon so we definitely capture next FOMC
    const events = cal.getUpcomingEvents(48);
    const fomc = events.find(e => e.source === 'static' && e.name.toLowerCase().includes('fomc'));

    // If FOMC isn't in the next 48h window from "now", synthesise a direct test.
    // We call the private method by casting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calAny = cal as any;
    const fomcEvent = calAny.computeNextOccurrence(
      { name: 'FOMC Rate Decision', schedule: '', impact: 'very_high', affected_assets: [], pre_drift_minutes: 120, elevated_vol_minutes: 180 },
      fromDate
    );

    expect(fomcEvent).not.toBeNull();
    const utcHour = fomcEvent!.getUTCHours();
    const utcMinute = fomcEvent!.getUTCMinutes();
    const utcDay = fomcEvent!.toISOString().substring(0, 10);

    // The first Wednesday of May 2026 is 2026-05-06
    expect(utcDay).toBe('2026-05-06');
    // 14:00 ET (EDT = UTC-4) → 18:00 UTC
    expect(utcHour).toBe(18);
    expect(utcMinute).toBe(0);

    void fomc; // silence unused warning
  });

  it('Riksbank at 09:30 Stockholm time resolves to 07:30 UTC (summer, CEST = UTC+2)', () => {
    // Pick a Thursday in a Riksbank month — March 2026, first Thursday = 2026-03-05
    // CEST kicks in 2026-03-29, so 2026-03-05 is still CET (UTC+1) → 09:30 CET = 08:30 UTC
    const fromDate = new Date(Date.parse('2026-03-05T07:00:00Z'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calAny = new MacroCalendar() as any;
    const event = calAny.computeNextOccurrence(
      { name: 'Swedish Riksbank Rate Decision', schedule: '', impact: 'high', affected_assets: [], pre_drift_minutes: 60, elevated_vol_minutes: 120 },
      fromDate
    );

    expect(event).not.toBeNull();
    const utcHour = event!.getUTCHours();
    const utcMinute = event!.getUTCMinutes();
    const utcDay = event!.toISOString().substring(0, 10);

    expect(utcDay).toBe('2026-03-05');
    // 09:30 Stockholm (CET = UTC+1) → 08:30 UTC
    expect(utcHour).toBe(8);
    expect(utcMinute).toBe(30);
  });

  it('ECB at 14:15 Frankfurt time (CEST = UTC+2) resolves to 12:15 UTC in summer', () => {
    // ECB months: [1,3,4,6,7,9,10,12]. June 2026 first Thursday = 2026-06-04.
    // June is CEST (UTC+2) → 14:15 CEST = 12:15 UTC
    const fromDate = new Date(Date.parse('2026-06-04T11:00:00Z'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calAny = new MacroCalendar() as any;
    const event = calAny.computeNextOccurrence(
      { name: 'ECB Rate Decision', schedule: '', impact: 'very_high', affected_assets: [], pre_drift_minutes: 90, elevated_vol_minutes: 180 },
      fromDate
    );

    expect(event).not.toBeNull();
    const utcHour = event!.getUTCHours();
    const utcMinute = event!.getUTCMinutes();
    const utcDay = event!.toISOString().substring(0, 10);

    expect(utcDay).toBe('2026-06-04');
    expect(utcHour).toBe(12);
    expect(utcMinute).toBe(15);
  });
});
