import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/recent', (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '30'), 10)));
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10)));
    const assetId = typeof req.query.asset_id === 'string' ? req.query.asset_id : null;
    const rows = services.db.prepare(`
      SELECT *
      FROM insider_trades
      WHERE transaction_date >= datetime('now', '-' || ? || ' days')
      ${assetId ? 'AND asset_id = ?' : ''}
      ORDER BY transaction_date DESC, created_at DESC
      LIMIT ?
    `).all(...(assetId ? [days, assetId, limit] : [days, limit]));

    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch insider trades', message: error?.message });
  }
});

export default router;
