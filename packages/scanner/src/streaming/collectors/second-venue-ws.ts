import WebSocket from 'ws';

export interface SecondVenueTick {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  timestamp: number;
}

export interface SecondVenueOptions {
  symbols: string[];
  enabled: boolean;
}

export class SecondVenueWsCollector {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private running = false;

  constructor(
    private options: SecondVenueOptions,
    private handlers: {
      onTick: (tick: SecondVenueTick) => void;
      onHealth: (detail: string) => void;
      onError: (context: string, error: unknown) => void;
    }
  ) {}

  start(): void {
    if (!this.options.enabled || this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      const product_ids = this.options.symbols.map(symbol => symbol.toUpperCase());
      socket.send(JSON.stringify({
        type: 'subscribe',
        channels: [{ name: 'ticker', product_ids }]
      }));
      this.handlers.onHealth('connected');
    });

    socket.on('message', (payload: WebSocket.RawData) => {
      try {
        const data = JSON.parse(payload.toString()) as any;
        if (data.type !== 'ticker') return;
        const tick: SecondVenueTick = {
          symbol: String(data.product_id || '').toUpperCase(),
          price: Number(data.price || 0),
          bid: data.best_bid != null ? Number(data.best_bid) : undefined,
          ask: data.best_ask != null ? Number(data.best_ask) : undefined,
          timestamp: data.time ? Date.parse(data.time) : Date.now()
        };
        if (!tick.symbol || !Number.isFinite(tick.price) || tick.price <= 0) return;
        this.handlers.onTick(tick);
        this.handlers.onHealth(`${tick.symbol} ticker`);
      } catch (error) {
        this.handlers.onError('second venue message', error);
      }
    });

    socket.on('close', () => {
      this.handlers.onHealth('socket closed');
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      this.handlers.onError('second venue socket', error);
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.connect();
    }, delay);
  }
}
