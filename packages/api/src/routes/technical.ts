import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/latest', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10)));
    const assetId = typeof req.query.asset_id === 'string' ? req.query.asset_id : null;
    const rows = services.db.prepare(`
      SELECT *
      FROM technical_snapshots
      ${assetId ? 'WHERE asset_id = ?' : ''}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(...(assetId ? [assetId, limit] : [limit]));

    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch technical snapshots', message: error?.message });
  }
});

export default router;
