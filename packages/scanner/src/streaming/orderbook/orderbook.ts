export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastUpdateId: number;
}

export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private depthLimit: number;
  private lastUpdateId = 0;
  private updatedAt = 0;

  constructor(depthLimit = 20) {
    this.depthLimit = depthLimit;
  }

  applySnapshot(snapshot: OrderBookSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const level of snapshot.bids) {
      if (level.size > 0) this.bids.set(level.price, level.size);
    }
    for (const level of snapshot.asks) {
      if (level.size > 0) this.asks.set(level.price, level.size);
    }
    this.lastUpdateId = snapshot.lastUpdateId;
    this.updatedAt = Date.now();
    this.trimToLimit();
  }

  applyDelta(
    updateId: number,
    bids: OrderBookLevel[],
    asks: OrderBookLevel[]
  ): void {
    for (const level of bids) {
      if (level.size <= 0) this.bids.delete(level.price);
      else this.bids.set(level.price, level.size);
    }
    for (const level of asks) {
      if (level.size <= 0) this.asks.delete(level.price);
      else this.asks.set(level.price, level.size);
    }
    this.lastUpdateId = updateId;
    this.updatedAt = Date.now();
    this.trimToLimit();
  }

  getTopLevels(levels = 20): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
    const bidLevels = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, levels)
      .map(([price, size]) => ({ price, size }));
    const askLevels = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, levels)
      .map(([price, size]) => ({ price, size }));
    return { bids: bidLevels, asks: askLevels };
  }

  bestBid(): OrderBookLevel | null {
    const bids = this.getTopLevels(1).bids;
    return bids[0] || null;
  }

  bestAsk(): OrderBookLevel | null {
    const asks = this.getTopLevels(1).asks;
    return asks[0] || null;
  }

  midPrice(): number | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask) return null;
    return (bid.price + ask.price) / 2;
  }

  spread(): number | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask) return null;
    return ask.price - bid.price;
  }

  getDepthWithinBps(bps: number): { bidDepth: number; askDepth: number } {
    const mid = this.midPrice();
    if (!mid || mid <= 0) {
      return { bidDepth: 0, askDepth: 0 };
    }

    const threshold = (bps / 10_000) * mid;
    const { bids, asks } = this.getTopLevels(this.depthLimit);
    const bidDepth = bids
      .filter(level => mid - level.price <= threshold)
      .reduce((sum, level) => sum + level.size, 0);
    const askDepth = asks
      .filter(level => level.price - mid <= threshold)
      .reduce((sum, level) => sum + level.size, 0);

    return { bidDepth, askDepth };
  }

  getLastUpdateId(): number {
    return this.lastUpdateId;
  }

  getUpdatedAt(): number {
    return this.updatedAt;
  }

  private trimToLimit(): void {
    const bids = [...this.bids.keys()].sort((a, b) => b - a);
    const asks = [...this.asks.keys()].sort((a, b) => a - b);

    for (let i = this.depthLimit; i < bids.length; i++) {
      this.bids.delete(bids[i]);
    }
    for (let i = this.depthLimit; i < asks.length; i++) {
      this.asks.delete(asks[i]);
    }
  }
}

