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

  // Server
  apiPort: number;
  nodeEnv: string;
}

export function loadConfig(): Config {
  return {
    // Scanner thresholds
    polyOddsChangeThreshold: parseFloat(process.env.POLY_ODDS_CHANGE_THRESHOLD || '8'),
    polyTimeWindowMinutes: parseInt(process.env.POLY_TIME_WINDOW_MINUTES || '60', 10),
    polyWhaleThresholdUsd: parseFloat(process.env.POLY_WHALE_THRESHOLD_USD || '25000'),
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

    // Server
    apiPort: parseInt(process.env.API_PORT || '3100', 10),
    nodeEnv: process.env.NODE_ENV || 'development'
  };
}

export function validateConfig(config: Config): void {
  const errors: string[] = [];

  if (!config.avanzaUsername) {
    errors.push('AVANZA_USERNAME is required');
  }

  if (!config.avanzaPassword) {
    errors.push('AVANZA_PASSWORD is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }
}
