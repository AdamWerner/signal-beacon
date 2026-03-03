import { WebhookConfig, AlertPayload } from './types.js';
import { GeneratedSignal } from '../signals/types.js';

export class WebhookClient {
  constructor(private config: WebhookConfig) {}

  async send(signal: GeneratedSignal): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const payload: AlertPayload = {
        signal,
        timestamp: new Date().toISOString()
      };

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error('Webhook error:', await response.text());
        return false;
      }

      console.log(`✓ Webhook alert sent for signal ${signal.id}`);
      return true;
    } catch (error) {
      console.error('Failed to send webhook alert:', error);
      return false;
    }
  }
}
