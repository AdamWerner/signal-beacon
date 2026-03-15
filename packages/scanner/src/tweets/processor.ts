import Database from 'better-sqlite3';
import { TweetStore, UnprocessedTweet } from '../storage/tweet-store.js';
import { runLocalAiPrompt } from '../utils/local-ai-cli.js';
import { shouldDoTweetProcessing } from '../utils/ai-budget.js';

export interface TweetIntelResult {
  tweetsAnalyzed: number;
  insightsGenerated: number;
  tokensUsed: number;
}

interface ParsedInsight {
  asset: string;
  direction: 'bull' | 'bear';
  confidence_boost: number;
  insight: string;
  category?: string;
}

export class TweetIntelligenceProcessor {
  private tweetStore: TweetStore;

  constructor(private db: Database.Database) {
    this.tweetStore = new TweetStore(db);
  }

  /**
   * Process unprocessed tweets in a single batch AI call.
   */
  async processTweetBatch(): Promise<TweetIntelResult> {
    if (!shouldDoTweetProcessing()) {
      console.log('  [ai-budget] Skipping tweet AI processing (dormant mode)');
      return { tweetsAnalyzed: 0, insightsGenerated: 0, tokensUsed: 0 };
    }

    const tweets = this.tweetStore.getUnprocessedTweets(200);

    if (tweets.length < 10) {
      console.log(`[tweet-intel] Only ${tweets.length} unprocessed items — skipping Claude (need 10+)`);
      return { tweetsAnalyzed: 0, insightsGenerated: 0, tokensUsed: 0 };
    }

    console.log(`[tweet-intel] Processing ${tweets.length} unprocessed tweets...`);

    const tweetSummary = this.buildPromptSummary(tweets);
    const assets = [
      'oil-equinor', 'oil-shell', 'oil-exxon', 'oil-conocophillips',
      'defense-saab', 'defense-rheinmetall', 'defense-bae', 'defense-lockheed',
      'ai-nvidia', 'ai-palantir', 'ai-crowdstrike',
      'ev-tesla', 'telecom-ericsson', 'steel-ssab', 'mining-boliden', 'gaming-evolution', 'retail-hm',
      'sp500', 'nasdaq100', 'omx30',
      'crypto-coinbase', 'shipping-zim', 'pharma-novo', 'mining-freeport', 'auto-volvo', 'tech-spotify'
    ].join(', ');

    const prompt = `You are a trading analyst. Analyze these recent tweets from financial accounts.

Valid asset ids: ${assets}

Tweets:\n${tweetSummary}

Return ONLY a JSON array of objects with this exact shape:
[{"asset":"asset-id","direction":"bull|bear","confidence_boost":5-20,"insight":"short reason","category":"macro|energy|defense|tech|swedish|crypto"}]

Rules:
- Include only actionable market-moving insights
- Skip generic opinions/noise
- confidence_boost must be integer 5-20
- If nothing actionable, return []`;

    const insights = await this.runClaudePrompt(prompt);
    const insightsStored = this.storeInsights(insights);

    this.tweetStore.markProcessed(tweets.map(tweet => tweet.id));

    console.log(`[tweet-intel] ${insightsStored} insights from ${tweets.length} tweets`);

    return {
      tweetsAnalyzed: tweets.length,
      insightsGenerated: insightsStored,
      tokensUsed: prompt.length + JSON.stringify(insights).length
    };
  }

  /**
   * Get compact tweet context for morning briefing prompt injection.
   */
  getTweetContextForBriefing(hours = 16): string {
    const summary = this.tweetStore.getTweetIntelligenceSummary(hours);
    if (summary.total === 0) return '';

    const topTweets = this.db.prepare(`
      SELECT ts.tweet_text, ts.account_handle, ta.weight, ta.category
      FROM tweet_snapshots ts
      JOIN tweet_accounts ta ON ta.handle = ts.account_handle
      WHERE ts.scraped_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY ta.weight DESC, ts.scraped_at DESC
      LIMIT 15
    `).all(hours) as Array<{
      tweet_text: string;
      account_handle: string;
      weight: number;
      category: string;
    }>;

    if (topTweets.length === 0) return '';

    const lines = topTweets.map(tweet =>
      `@${tweet.account_handle} (${tweet.category}): ${tweet.tweet_text.substring(0, 150)}`
    ).join('\n');

    return `\nRecent high-influence tweets (${summary.total} total, last ${hours}h):\n${lines}`;
  }

  private buildPromptSummary(tweets: UnprocessedTweet[]): string {
    const byCategory = new Map<string, UnprocessedTweet[]>();

    for (const tweet of tweets) {
      if (!byCategory.has(tweet.category)) {
        byCategory.set(tweet.category, []);
      }
      byCategory.get(tweet.category)!.push(tweet);
    }

    return Array.from(byCategory.entries())
      .map(([category, categoryTweets]) => {
        const lines = categoryTweets.slice(0, 30).map((tweet, index) =>
          `  ${index + 1}. @${tweet.account_handle}: ${tweet.tweet_text.substring(0, 200)}`
        ).join('\n');

        return `[${category.toUpperCase()}] (${categoryTweets.length} tweets)\n${lines}`;
      })
      .join('\n\n');
  }

  private async runClaudePrompt(prompt: string): Promise<ParsedInsight[]> {
    const result = await runLocalAiPrompt(prompt, {
      timeoutMs: 90000,
      maxBufferBytes: 1024 * 1024,
      usageContext: 'tweet-process',
      logContext: 'tweet-process'
    });
    if (!result.ok) return [];
    return this.parseInsights(result.stdout);
  }

  private parseInsights(rawOutput: string): ParsedInsight[] {
    const cleaned = rawOutput
      .trim()
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();

    const jsonStart = cleaned.indexOf('[');
    const jsonEnd = cleaned.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd < 0 || jsonEnd < jsonStart) return [];

    try {
      const maybeArray = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
      if (!Array.isArray(maybeArray)) return [];

      return maybeArray.filter((item): item is ParsedInsight => {
        return (
          typeof item?.asset === 'string' &&
          (item?.direction === 'bull' || item?.direction === 'bear') &&
          typeof item?.insight === 'string'
        );
      });
    } catch {
      return [];
    }
  }

  private storeInsights(insights: ParsedInsight[]): number {
    let stored = 0;

    for (const insight of insights) {
      const confidenceBoost = Math.max(5, Math.min(Math.round(insight.confidence_boost || 5), 20));

      try {
        this.db.prepare(`
          INSERT INTO intelligence_memory (
            category, insight, affected_assets, confidence_boost,
            decay_days, source_signals, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+2 days'))
        `).run(
          `tweet_${insight.category || 'general'}`,
          `Tweet: ${insight.insight}`,
          JSON.stringify([insight.asset]),
          confidenceBoost,
          2,
          JSON.stringify([`tweet_batch_${Date.now()}`])
        );

        stored += 1;
      } catch (error) {
        console.error('[tweet-intel] Failed to store insight:', error);
      }
    }

    return stored;
  }
}
