import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/recent', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(24 * 14, parseInt(String(req.query.hours || '24'), 10)));
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10)));
    const assetId = typeof req.query.asset_id === 'string' ? req.query.asset_id : undefined;
    const rows = services.catalystStore.getRecentCatalysts(hours, assetId, limit).map((row: any) => ({
      ...row,
      asset_ids: safeJson(row.asset_ids),
      metadata: safeJson(row.metadata_json)
    }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch catalysts', message: error?.message });
  }
});

router.get('/by-asset/:id', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(24 * 30, parseInt(String(req.query.hours || '168'), 10)));
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10)));
    const rows = services.catalystStore.getRecentCatalysts(hours, req.params.id, limit).map((row: any) => ({
      ...row,
      asset_ids: safeJson(row.asset_ids),
      metadata: safeJson(row.metadata_json)
    }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch asset catalysts', message: error?.message });
  }
});

router.get('/diagnostics', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '20'), 10)));
    res.json(services.catalystStore.getSourceFamilyDiagnostics(limit));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch source diagnostics', message: error?.message });
  }
});

router.get('/signal/:signalId', (req, res) => {
  try {
    const rows = services.catalystStore.getSignalCatalysts(req.params.signalId).map((row: any) => ({
      ...row,
      asset_ids: safeJson(row.asset_ids),
      metadata: safeJson(row.metadata_json)
    }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch signal catalysts', message: error?.message });
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
