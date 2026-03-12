import WebSocket from 'ws';
import { OrderBookLevel, OrderBookSnapshot } from '../orderbook/orderbook.js';

export interface BinanceTradeTick {
  symbol: string;
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface BinanceLiquidationTick {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  timestamp: number;
}

export interface BinanceDepthEvent {
  symbol: string;
  U: number;
  u: number;
  pu?: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface BinanceCollectorHandlers {
  onDepth: (event: BinanceDepthEvent) => void;
  onTrade: (trade: BinanceTradeTick) => void;
  onLiquidation?: (tick: BinanceLiquidationTick) => void;
  onSnapshot: (symbol: string, snapshot: OrderBookSnapshot) => void;
  onHealth: (component: 'binance_depth' | 'binance_trades' | 'binance_liquidations', detail: string) => void;
  onError: (context: string, error: unknown) => void;
}

export interface BinanceCollectorOptions {
  symbols: string[];
  enableDepth: boolean;
  enableTrades: boolean;
  enableLiquidations: boolean;
}

export class BinanceFuturesWsCollector {
  private combinedSocket: WebSocket | null = null;
  private liquidationSocket: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private snapshotInterval: NodeJS.Timeout | null = null;

  constructor(
    private options: BinanceCollectorOptions,
    private handlers: BinanceCollectorHandlers
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshSnapshots();
    this.connectCombined();
    if (this.options.enableLiquidations) {
      this.connectLiquidations();
    }
    this.snapshotInterval = setInterval(() => {
      this.refreshSnapshots().catch(error => this.handlers.onError('binance snapshot refresh', error));
    }, 5 * 60 * 1000);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    this.reconnectTimer = null;
    this.snapshotInterval = null;
    this.combinedSocket?.close();
    this.liquidationSocket?.close();
    this.combinedSocket = null;
    this.liquidationSocket = null;
  }

  private connectCombined(): void {
    const streams: string[] = [];
    for (const symbol of this.options.symbols) {
      const lower = symbol.toLowerCase();
      if (this.options.enableDepth) streams.push(`${lower}@depth@100ms`);
      if (this.options.enableTrades) streams.push(`${lower}@trade`);
    }

    if (streams.length === 0) return;
    const url = `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;
    const socket = new WebSocket(url);
    this.combinedSocket = socket;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      if (this.options.enableDepth) this.handlers.onHealth('binance_depth', 'connected');
      if (this.options.enableTrades) this.handlers.onHealth('binance_trades', 'connected');
    });

    socket.on('message', (payload: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(payload.toString()) as { stream?: string; data?: any };
        const data = parsed.data || parsed;
        const eventType = String(data?.e || '');
        if (eventType === 'depthUpdate') {
          const event: BinanceDepthEvent = {
            symbol: String(data.s || '').toUpperCase(),
            U: Number(data.U || 0),
            u: Number(data.u || 0),
            pu: data.pu != null ? Number(data.pu) : undefined,
            bids: Array.isArray(data.b)
              ? data.b.map((level: [string, string]) => ({ price: Number(level[0]), size: Number(level[1]) }))
              : [],
            asks: Array.isArray(data.a)
              ? data.a.map((level: [string, string]) => ({ price: Number(level[0]), size: Number(level[1]) }))
              : []
          };
          this.handlers.onDepth(event);
          this.handlers.onHealth('binance_depth', `${event.symbol} depth update`);
        } else if (eventType === 'trade') {
          const trade: BinanceTradeTick = {
            symbol: String(data.s || '').toUpperCase(),
            price: Number(data.p || 0),
            quantity: Number(data.q || 0),
            timestamp: Number(data.T || Date.now()),
            isBuyerMaker: Boolean(data.m)
          };
          this.handlers.onTrade(trade);
          this.handlers.onHealth('binance_trades', `${trade.symbol} trade`);
        }
      } catch (error) {
        this.handlers.onError('binance combined message', error);
      }
    });

    socket.on('close', () => {
      if (this.options.enableDepth) this.handlers.onHealth('binance_depth', 'socket closed');
      if (this.options.enableTrades) this.handlers.onHealth('binance_trades', 'socket closed');
      this.scheduleReconnect('combined');
    });

    socket.on('error', (error: Error) => {
      this.handlers.onError('binance combined socket', error);
    });
  }

  private connectLiquidations(): void {
    const url = 'wss://fstream.binance.com/ws/!forceOrder@arr';
    const socket = new WebSocket(url);
    this.liquidationSocket = socket;

    socket.on('open', () => {
      this.handlers.onHealth('binance_liquidations', 'connected');
    });

    socket.on('message', (payload: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(payload.toString()) as any;
        const events = Array.isArray(parsed?.o) ? parsed.o : Array.isArray(parsed) ? parsed : [parsed];
        for (const event of events) {
          const order = event?.o || event;
          if (!order) continue;
          const tick: BinanceLiquidationTick = {
            symbol: String(order.s || '').toUpperCase(),
            side: String(order.S || '').toUpperCase() === 'SELL' ? 'sell' : 'buy',
            price: Number(order.p || 0),
            quantity: Number(order.q || 0),
            timestamp: Number(order.T || Date.now())
          };
          this.handlers.onLiquidation?.(tick);
          this.handlers.onHealth('binance_liquidations', `${tick.symbol} liquidation`);
        }
      } catch (error) {
        this.handlers.onError('binance liquidation message', error);
      }
    });

    socket.on('close', () => {
      this.handlers.onHealth('binance_liquidations', 'socket closed');
      this.scheduleReconnect('liquidation');
    });

    socket.on('error', (error: Error) => {
      this.handlers.onError('binance liquidation socket', error);
    });
  }

  private scheduleReconnect(kind: 'combined' | 'liquidation'): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      if (kind === 'combined') this.connectCombined();
      if (kind === 'liquidation' && this.options.enableLiquidations) this.connectLiquidations();
    }, delay);
  }

  private async refreshSnapshots(): Promise<void> {
    for (const symbol of this.options.symbols) {
      try {
        const snapshot = await this.fetchSnapshot(symbol);
        this.handlers.onSnapshot(symbol, snapshot);
      } catch (error) {
        this.handlers.onError(`binance snapshot ${symbol}`, error);
      }
    }
  }

  private async fetchSnapshot(symbol: string): Promise<OrderBookSnapshot> {
    const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=20`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'PolySignal/1.0' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`snapshot ${symbol} status ${response.status}`);
    }
    const data = await response.json() as any;
    const bids: OrderBookLevel[] = Array.isArray(data.bids)
      ? data.bids.map((level: [string, string]) => ({ price: Number(level[0]), size: Number(level[1]) }))
      : [];
    const asks: OrderBookLevel[] = Array.isArray(data.asks)
      ? data.asks.map((level: [string, string]) => ({ price: Number(level[0]), size: Number(level[1]) }))
      : [];
    return {
      bids,
      asks,
      lastUpdateId: Number(data.lastUpdateId || 0)
    };
  }
}
