import Database from 'better-sqlite3';

export interface Instrument {
  id: string;
  avanza_id: string;
  name: string;
  direction: 'bull' | 'bear';
  underlying: string;
  leverage: number | null;
  issuer: string | null;
  instrument_url: string;
  is_active: boolean;
  last_verified_at: string | null;
  discovered_at: string;
  delisted_at: string | null;
}

export interface InsertInstrument {
  id: string;
  avanza_id: string;
  name: string;
  direction: 'bull' | 'bear';
  underlying: string;
  leverage: number | null;
  issuer: string | null;
  instrument_url: string;
}

export class InstrumentStore {
  constructor(private db: Database.Database) {}

  insert(instrument: InsertInstrument): void {
    const stmt = this.db.prepare(`
      INSERT INTO instruments (
        id, avanza_id, name, direction, underlying, leverage, issuer, instrument_url, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(avanza_id) DO UPDATE SET
        name = excluded.name,
        direction = excluded.direction,
        underlying = excluded.underlying,
        leverage = excluded.leverage,
        issuer = excluded.issuer,
        instrument_url = excluded.instrument_url,
        last_verified_at = CURRENT_TIMESTAMP,
        is_active = TRUE
    `);

    stmt.run(
      instrument.id,
      instrument.avanza_id,
      instrument.name,
      instrument.direction,
      instrument.underlying,
      instrument.leverage,
      instrument.issuer,
      instrument.instrument_url
    );
  }

  findByUnderlying(underlying: string, direction?: 'bull' | 'bear'): Instrument[] {
    const stmt = direction
      ? this.db.prepare(`
          SELECT * FROM instruments
          WHERE underlying = ? AND direction = ? AND is_active = TRUE
          ORDER BY leverage ASC, discovered_at DESC
        `)
      : this.db.prepare(`
          SELECT * FROM instruments
          WHERE underlying = ? AND is_active = TRUE
          ORDER BY direction, leverage ASC, discovered_at DESC
        `);

    return direction ? stmt.all(underlying, direction) as Instrument[] : stmt.all(underlying) as Instrument[];
  }

  findByAvanzaId(avanza_id: string): Instrument | undefined {
    const stmt = this.db.prepare('SELECT * FROM instruments WHERE avanza_id = ?');
    return stmt.get(avanza_id) as Instrument | undefined;
  }

  findAll(activeOnly = true): Instrument[] {
    const stmt = activeOnly
      ? this.db.prepare('SELECT * FROM instruments WHERE is_active = TRUE ORDER BY underlying, direction, leverage')
      : this.db.prepare('SELECT * FROM instruments ORDER BY underlying, direction, leverage');

    return stmt.all() as Instrument[];
  }

  markAsInactive(avanza_id: string): void {
    const stmt = this.db.prepare(`
      UPDATE instruments
      SET is_active = FALSE, delisted_at = CURRENT_TIMESTAMP
      WHERE avanza_id = ? AND is_active = TRUE
    `);
    stmt.run(avanza_id);
  }

  markStaleAsInactive(daysSinceVerification: number): number {
    const stmt = this.db.prepare(`
      UPDATE instruments
      SET is_active = FALSE, delisted_at = CURRENT_TIMESTAMP
      WHERE is_active = TRUE
        AND last_verified_at < datetime('now', '-' || ? || ' days')
    `);

    const info = stmt.run(daysSinceVerification);
    return info.changes;
  }

  countByUnderlying(): Record<string, { bull: number; bear: number }> {
    const stmt = this.db.prepare(`
      SELECT underlying, direction, COUNT(*) as count
      FROM instruments
      WHERE is_active = TRUE
      GROUP BY underlying, direction
    `);

    const results = stmt.all() as Array<{ underlying: string; direction: string; count: number }>;
    const counts: Record<string, { bull: number; bear: number }> = {};

    results.forEach(row => {
      if (!counts[row.underlying]) {
        counts[row.underlying] = { bull: 0, bear: 0 };
      }
      if (row.direction === 'bull') {
        counts[row.underlying].bull = row.count;
      } else {
        counts[row.underlying].bear = row.count;
      }
    });

    return counts;
  }
}
