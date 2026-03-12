import { OrderBook, OrderBookLevel, OrderBookSnapshot } from './orderbook.js';

export interface BinanceDepthDelta {
  symbol: string;
  U: number;
  u: number;
  pu?: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

interface BookState {
  book: OrderBook;
  initialized: boolean;
  needsResync: boolean;
}

export class OrderBookManager {
  private books = new Map<string, BookState>();

  constructor(private depthLimit = 20) {}

  ensureBook(symbol: string): OrderBook {
    const normalized = symbol.toUpperCase();
    const current = this.books.get(normalized);
    if (current) return current.book;
    const state: BookState = {
      book: new OrderBook(this.depthLimit),
      initialized: false,
      needsResync: true
    };
    this.books.set(normalized, state);
    return state.book;
  }

  applySnapshot(symbol: string, snapshot: OrderBookSnapshot): void {
    const state = this.getState(symbol);
    state.book.applySnapshot(snapshot);
    state.initialized = true;
    state.needsResync = false;
  }

  applyDelta(delta: BinanceDepthDelta): boolean {
    const state = this.getState(delta.symbol);
    if (!state.initialized) {
      state.needsResync = true;
      return false;
    }

    const lastUpdate = state.book.getLastUpdateId();
    if (delta.pu != null && delta.pu !== lastUpdate) {
      state.needsResync = true;
      return false;
    }

    if (delta.u <= lastUpdate) {
      return true;
    }

    if (delta.U > lastUpdate + 1) {
      state.needsResync = true;
      return false;
    }

    state.book.applyDelta(delta.u, delta.bids, delta.asks);
    return true;
  }

  needsResync(symbol: string): boolean {
    return this.getState(symbol).needsResync;
  }

  markResync(symbol: string): void {
    const state = this.getState(symbol);
    state.needsResync = true;
  }

  getBook(symbol: string): OrderBook | null {
    const state = this.books.get(symbol.toUpperCase());
    if (!state || !state.initialized) return null;
    return state.book;
  }

  getSymbols(): string[] {
    return Array.from(this.books.keys());
  }

  private getState(symbol: string): BookState {
    const normalized = symbol.toUpperCase();
    const current = this.books.get(normalized);
    if (current) return current;
    const state: BookState = {
      book: new OrderBook(this.depthLimit),
      initialized: false,
      needsResync: true
    };
    this.books.set(normalized, state);
    return state;
  }
}

