import { GeneratedSignal } from '../signals/types.js';

export interface AlertConfig {
  pushover?: PushoverConfig;
  webhook?: WebhookConfig;
  minConfidence?: number;
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
