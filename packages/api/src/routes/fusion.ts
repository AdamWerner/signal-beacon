import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices() as any;

router.get('/decisions', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '100'), 10)));
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    const rows = store.getFusionDecisions(limit).map((row: any) => ({
      ...row,
      reasons: safeJson(row.reasons_json),
      suppress_reasons: safeJson(row.suppress_reasons_json),
      feature_flags_used: safeJson(row.feature_flags_used_json)
    }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch fusion decisions', message: error?.message });
  }
});

router.get('/suppressed', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '100'), 10)));
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    const rows = store.getSuppressedDecisions(limit).map((row: any) => ({
      ...row,
      reasons: safeJson(row.reasons_json),
      suppress_reasons: safeJson(row.suppress_reasons_json),
      feature_flags_used: safeJson(row.feature_flags_used_json)
    }));
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch suppressed decisions', message: error?.message });
  }
});

router.get('/latest', (_req, res) => {
  try {
    const store = services.streamingStore;
    if (!store) return res.status(503).json({ error: 'Streaming store unavailable' });
    const rows = store.getFusionDecisions(1);
    if (rows.length === 0) return res.json(null);
    const row = rows[0];
    res.json({
      ...row,
      reasons: safeJson(row.reasons_json),
      suppress_reasons: safeJson(row.suppress_reasons_json),
      feature_flags_used: safeJson(row.feature_flags_used_json)
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch latest fusion decision', message: error?.message });
  }
});

function safeJson(value: string | null | undefined): any[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export default router;

