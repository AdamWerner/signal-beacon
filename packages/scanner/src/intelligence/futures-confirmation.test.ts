import { describe, expect, it } from 'vitest';
import { FuturesConfirmationService } from './futures-confirmation.js';

function createSignal(assetId: string, direction: 'bull' | 'bear' = 'bull') {
  return {
    matched_asset_id: assetId,
    suggested_action: `Consider ${direction.toUpperCase()} position`
  } as any;
}

describe('FuturesConfirmationService', () => {
  it('skips ambiguous shipping proxy confirmations', async () => {
    const service = new FuturesConfirmationService();

    await expect(service.confirm(createSignal('shipping-zim'))).resolves.toBeNull();
  });

  it('skips ambiguous coinbase proxy confirmations instead of falling back to COIN stock', async () => {
    const service = new FuturesConfirmationService();

    await expect(service.confirm(createSignal('crypto-coinbase'))).resolves.toBeNull();
  });

  it('still confirms explicit futures mappings for supported assets', async () => {
    const service = new FuturesConfirmationService() as any;
    service.getReturn5m = async () => 0.4;

    const result = await service.confirm(createSignal('sp500', 'bull'));

    expect(result).not.toBeNull();
    expect(result.symbol).toBe('ES=F');
    expect(result.alignment).toBe('confirms');
  });
});
