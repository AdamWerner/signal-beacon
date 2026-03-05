import { GeneratedSignal } from '../signals/types.js';

export interface HomeAssistantConfig {
  url: string;
  token: string;
  notifyService: string;
  minConfidence: number;
  enabled: boolean;
}

export interface AlertConfig {
  pushover?: PushoverConfig;
  webhook?: WebhookConfig;
  homeAssistant?: HomeAssistantConfig;
  minConfidence?: number;
  verificationRequiredForPush?: boolean;
  intradayMinConfidenceHa?: number;
  onSignalsPushed?: (signalIds: string[], market: 'swedish' | 'us') => void;
}

export interface PushoverConfig {
  userKey: string;
  appToken: string;
  enabled: boolean;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
}

export interface AlertPayload {
  signal: GeneratedSignal;
  timestamp: string;
}
