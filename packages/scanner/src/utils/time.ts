/**
 * Parse a timestamp from the database, an RSS feed, or an ISO string as UTC.
 * SQLite stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' (UTC, no suffix),
 * which JavaScript's Date.parse otherwise interprets as local time.
 * Returns epoch milliseconds, or NaN if unparseable.
 */
export function parseDbTimestampMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const trimmed = String(value).trim();
  if (!trimmed) return NaN;
  // Already has timezone marker (Z or +hh:mm or -hh:mm after the time)
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return Date.parse(trimmed);
  }
  // SQLite 'YYYY-MM-DD HH:MM:SS' → treat as UTC
  const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  return Date.parse(withT + 'Z');
}
