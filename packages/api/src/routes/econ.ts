import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/surprises', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(24 * 30, parseInt(String(req.query.hours || '168'), 10)));
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10)));
    const rows = services.db.prepare(`
      SELECT *
      FROM econ_surprises
      WHERE event_time >= datetime('now', '-' || ? || ' hours')
      ORDER BY event_time DESC
      LIMIT ?
    `).all(hours, limit);

    res.json(rows.map((row: any) => ({
      ...row,
      affected_assets: safeJson(row.affected_assets)
    })));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch econ surprises', message: error?.message });
  }
});

function safeJson(value: string | null | undefined) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export default router;
