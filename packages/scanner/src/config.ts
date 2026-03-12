import { logger } from './utils/logger.js';

export interface Config {
  // Scanner thresholds
  polyOddsChangeThreshold: number;
  polyTimeWindowMinutes: number;
  polyWhaleThresholdUsd: number;
  polyMarketRelevanceThreshold: number;

  // Job schedules (cron syntax)
  jobScanCron: string;
  jobMarketRefreshCron: string;
  jobInstrumentRefreshCron: string;
  jobCleanupCron: string;

  // Avanza
  avanzaUsername: string;
  avanzaPassword: string;
  avanzaTotpSecret?: string;
  avanzaSearchDelayMs: number;
  avanzaBaseUrl: string;

  // Alerts
  alertMinConfidence: number;
  alertPushoverUserKey?: string;
  alertPushoverAppToken?: string;
  alertWebhookUrl?: string;
  verificationRequiredForPush: boolean;

  // Verification
  entityConfidenceThreshold: number;
  unknownPersonLegalEventPolicy: 'block' | 'review';

  // Home Assistant
  haUrl: string;
  haToken: string;
  haNotifyService: string;
  alertMinConfidenceHa: number;

  // Streaming / fusion (Phase 2+)
  enableStreamingLayer: boolean;
  enableBinanceDepth: boolean;
  enableBinanceTrades: boolean;
  enableLiquidations: boolean;
  enableSecondVenue: boolean;
  enableFusionGating: boolean;
  enableSuppressedDecisionStorage: boolean;
  enableDashboardStreamingViews: boolean;
  streamingKillSwitch: boolean;
  streamingSymbols: string[];
  streamingStaleMs: number;
  fusionPHatMin: number;
  fusionExpectancyMinPct: number;

  // Server
  apiPort: number;
  nodeEnv: string;
  publicUrl: string;
}

export function loadConfig(): Config {
  return {
    // Scanner thresholds
    polyOddsChangeThreshold: parseFloat(process.env.POLY_ODDS_CHANGE_THRESHOLD || '8'),
    polyTimeWindowMinutes: parseInt(process.env.POLY_TIME_WINDOW_MINUTES || '60', 10),
    polyWhaleThresholdUsd: parseFloat(process.env.POLY_WHALE_THRESHOLD_USD || '5000'),
    polyMarketRelevanceThreshold: parseFloat(process.env.POLY_MARKET_RELEVANCE_THRESHOLD || '0.4'),

    // Job schedules
    jobScanCron: process.env.JOB_SCAN_CRON || '*/15 * * * *', // Every 15 minutes
    jobMarketRefreshCron: process.env.JOB_MARKET_REFRESH_CRON || '0 */6 * * *', // Every 6 hours
    jobInstrumentRefreshCron: process.env.JOB_INSTRUMENT_REFRESH_CRON || '0 6 * * *', // Daily at 6 AM
    jobCleanupCron: process.env.JOB_CLEANUP_CRON || '0 3 * * *', // Daily at 3 AM

    // Avanza
    avanzaUsername: process.env.AVANZA_USERNAME || '',
    avanzaPassword: process.env.AVANZA_PASSWORD || '',
    avanzaTotpSecret: process.env.AVANZA_TOTP_SECRET,
    avanzaSearchDelayMs: parseInt(process.env.AVANZA_SEARCH_DELAY_MS || '2000', 10),
    avanzaBaseUrl: process.env.AVANZA_BASE_URL || 'https://www.avanza.se',

    // Alerts
    alertMinConfidence: parseInt(process.env.ALERT_MIN_CONFIDENCE || '50', 10),
    alertPushoverUserKey: process.env.ALERT_PUSHOVER_USER_KEY,
    alertPushoverAppToken: process.env.ALERT_PUSHOVER_APP_TOKEN,
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
    verificationRequiredForPush: (process.env.VERIFICATION_REQUIRED_FOR_PUSH || 'true').toLowerCase() !== 'false',

    // Verification
    entityConfidenceThreshold: parseFloat(process.env.ENTITY_CONFIDENCE_THRESHOLD || '0.55'),
    unknownPersonLegalEventPolicy: (process.env.UNKNOWN_PERSON_LEGAL_EVENT_POLICY || 'block').toLowerCase() === 'review'
      ? 'review'
      : 'block',

    // Home Assistant
    haUrl: process.env.HA_URL || '',
    haToken: process.env.HA_TOKEN || '',
    haNotifyService: process.env.HA_NOTIFY_SERVICE || 'notify.mobile_app_adamsajphone',
    alertMinConfidenceHa: parseInt(process.env.ALERT_MIN_CONFIDENCE_HA || '65', 10),

    // Streaming / fusion
    enableStreamingLayer: (process.env.ENABLE_STREAMING_LAYER || 'false').toLowerCase() === 'true',
    enableBinanceDepth: (process.env.ENABLE_BINANCE_DEPTH || 'true').toLowerCase() !== 'false',
    enableBinanceTrades: (process.env.ENABLE_BINANCE_TRADES || 'true').toLowerCase() !== 'false',
    enableLiquidations: (process.env.ENABLE_LIQUIDATIONS || 'false').toLowerCase() === 'true',
    enableSecondVenue: (process.env.ENABLE_SECOND_VENUE || 'false').toLowerCase() === 'true',
    enableFusionGating: (process.env.ENABLE_FUSION_GATING || 'false').toLowerCase() === 'true',
    enableSuppressedDecisionStorage: (process.env.ENABLE_SUPPRESSED_DECISION_STORAGE || 'true').toLowerCase() !== 'false',
    enableDashboardStreamingViews: (process.env.ENABLE_DASHBOARD_STREAMING_VIEWS || 'true').toLowerCase() !== 'false',
    streamingKillSwitch: (process.env.STREAMING_KILL_SWITCH || 'false').toLowerCase() === 'true',
    streamingSymbols: (process.env.STREAMING_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
      .split(',')
      .map(symbol => symbol.trim().toUpperCase())
      .filter(Boolean),
    streamingStaleMs: parseInt(process.env.STREAMING_STALE_MS || '15000', 10),
    fusionPHatMin: parseFloat(process.env.FUSION_P_HAT_MIN || '0.55'),
    fusionExpectancyMinPct: parseFloat(process.env.FUSION_EXPECTANCY_MIN_PCT || '0.30'),

    // Server
    apiPort: parseInt(process.env.API_PORT || '3100', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3100'
  };
}

export function validateConfig(config: Config): void {
  if (!config.avanzaUsername || !config.avanzaPassword) {
    logger.warn('Avanza credentials not configured — running in Polymarket-only mode');
  }
}
