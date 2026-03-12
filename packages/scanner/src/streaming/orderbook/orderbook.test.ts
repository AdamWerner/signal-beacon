import { describe, expect, it } from 'vitest';
import { OrderBook } from './orderbook.js';
import { OrderBookManager } from './orderbook-manager.js';

describe('OrderBook', () => {
  it('applies snapshot and computes best bid/ask + mid', () => {
    const book = new OrderBook(20);
    book.applySnapshot({
      lastUpdateId: 100,
      bids: [{ price: 100, size: 3 }, { price: 99, size: 2 }],
      asks: [{ price: 101, size: 4 }, { price: 102, size: 1 }]
    });

    expect(book.bestBid()?.price).toBe(100);
    expect(book.bestAsk()?.price).toBe(101);
    expect(book.midPrice()).toBe(100.5);
  });

  it('applies deltas and removes zero-sized levels', () => {
    const book = new OrderBook(20);
    book.applySnapshot({
      lastUpdateId: 10,
      bids: [{ price: 100, size: 3 }],
      asks: [{ price: 101, size: 2 }]
    });
    book.applyDelta(11, [{ price: 100, size: 0 }, { price: 99.5, size: 4 }], []);
    expect(book.bestBid()?.price).toBe(99.5);
  });
});

describe('OrderBookManager', () => {
  it('requires resync on sequence gap', () => {
    const manager = new OrderBookManager(20);
    manager.applySnapshot('BTCUSDT', {
      lastUpdateId: 100,
      bids: [{ price: 100, size: 1 }],
      asks: [{ price: 101, size: 1 }]
    });

    const ok = manager.applyDelta({
      symbol: 'BTCUSDT',
      U: 105,
      u: 106,
      pu: 100,
      bids: [{ price: 100, size: 2 }],
      asks: [{ price: 101, size: 2 }]
    });

    expect(ok).toBe(false);
    expect(manager.needsResync('BTCUSDT')).toBe(true);
  });
});

