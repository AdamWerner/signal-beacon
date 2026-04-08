import { describe, it, expect } from 'vitest';
import { parseDbTimestampMs } from './time.js';

// Canonical UTC epoch for our test timestamp — computed from an unambiguous ISO string
// so the test is independent of the machine's local timezone.
const UTC_EPOCH = Date.parse('2026-04-07T12:00:00Z');

describe('parseDbTimestampMs', () => {
  it('parses SQLite YYYY-MM-DD HH:MM:SS as UTC (core regression)', () => {
    // SQLite stores timestamps in this format; they represent UTC, no suffix.
    // In Europe/Stockholm (CEST = UTC+2), naive Date.parse would interpret
    // this as 12:00 local = 10:00 UTC, giving UTC_EPOCH - 7200000.
    // Our function must return UTC_EPOCH.
    expect(parseDbTimestampMs('2026-04-07 12:00:00')).toBe(UTC_EPOCH);
  });

  it('parses ISO string with Z suffix as UTC', () => {
    expect(parseDbTimestampMs('2026-04-07T12:00:00Z')).toBe(UTC_EPOCH);
  });

  it('SQLite format and ISO-Z format produce identical results', () => {
    expect(parseDbTimestampMs('2026-04-07 12:00:00')).toBe(
      parseDbTimestampMs('2026-04-07T12:00:00Z')
    );
  });

  it('parses ISO string with +02:00 offset — 12:00+02:00 = 10:00 UTC', () => {
    const tenUtc = Date.parse('2026-04-07T10:00:00Z');
    expect(parseDbTimestampMs('2026-04-07T12:00:00+02:00')).toBe(tenUtc);
  });

  it('returns NaN for empty string', () => {
    expect(parseDbTimestampMs('')).toBeNaN();
  });

  it('returns NaN for null', () => {
    expect(parseDbTimestampMs(null)).toBeNaN();
  });

  it('returns NaN for undefined', () => {
    expect(parseDbTimestampMs(undefined)).toBeNaN();
  });

  it('SQLite timestamp is treated as UTC, NOT as local time', () => {
    const sqliteResult = parseDbTimestampMs('2026-04-07 12:00:00');
    const naiveLocalResult = new Date('2026-04-07T12:00:00').getTime(); // local interpretation
    // Our function must match the UTC interpretation
    expect(sqliteResult).toBe(UTC_EPOCH);
    // In any timezone with non-zero UTC offset, naive local parse differs from UTC.
    // In UTC itself they're equal — that's fine, the core correctness test above still passes.
    // This assertion is informational for non-UTC machines.
    if (new Date().getTimezoneOffset() !== 0) {
      expect(sqliteResult).not.toBe(naiveLocalResult);
    }
  });
});
