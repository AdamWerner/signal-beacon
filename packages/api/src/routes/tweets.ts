import { Router } from 'express';
import { scanner } from '@polysignal/scanner';

const router = Router();
const services = scanner.getServices();
const tweetStore = services.tweetStore;

// GET /api/tweets - Recent tweets
router.get('/', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string, 10) || 24;
    const db = (services as any).db;

    const tweets = db.prepare(`
      SELECT ts.*, ta.display_name, ta.category, ta.weight
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ts.scraped_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY ts.scraped_at DESC
      LIMIT 200
    `).all(hours);

    res.json(tweets);
  } catch {
    res.status(500).json({ error: 'Failed to fetch tweets' });
  }
});

// GET /api/tweets/accounts - Monitored accounts
router.get('/accounts', (req, res) => {
  try {
    res.json(tweetStore.getActiveAccounts());
  } catch {
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// GET /api/tweets/stats - Tweet intelligence summary
router.get('/stats', (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string, 10) || 24;
    res.json(tweetStore.getTweetIntelligenceSummary(hours));
  } catch {
    res.status(500).json({ error: 'Failed to fetch tweet stats' });
  }
});

// POST /api/tweets/import - Manually import a tweet
router.post('/import', (req, res) => {
  try {
    const handle = `${req.body?.handle || ''}`.trim();
    const text = `${req.body?.text || ''}`.trim();

    if (!handle || !text) {
      return res.status(400).json({ error: 'handle and text are required' });
    }

    tweetStore.insertTweet({
      account_handle: handle,
      tweet_text: text,
      tweet_url: req.body?.url,
      tweet_id: req.body?.tweet_id || `manual_${Date.now()}`
    });

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to import tweet' });
  }
});

// POST /api/tweets/collect - Trigger manual tweet collection
router.post('/collect', async (req, res) => {
  try {
    const result = await scanner.runTweetCollection();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: 'Tweet collection failed', message: error?.message });
  }
});

// POST /api/tweets/process - Trigger tweet AI processing
router.post('/process', async (req, res) => {
  try {
    const result = await scanner.runTweetProcessing();
    res.json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ error: 'Tweet processing failed', message: error?.message });
  }
});

export default router;
