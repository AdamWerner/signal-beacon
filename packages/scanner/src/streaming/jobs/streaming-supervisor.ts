import { BinanceFuturesWsCollector } from '../collectors/binance-futures-ws.js';
import { SecondVenueWsCollector } from '../collectors/second-venue-ws.js';
import { FeatureAggregator } from '../features/aggregator.js';
import { OrderBookManager } from '../orderbook/orderbook-manager.js';
import { StreamingStore } from '../storage/streaming-store.js';
import { StreamingFeatureService } from '../services/streaming-feature-service.js';
import { StreamingHealthService } from '../services/streaming-health-service.js';
import { StreamingSymbolMap } from '../services/symbol-map.js';

export interface StreamingSupervisorOptions {
  symbols: string[];
  secondVenueSymbols: string[];
  enableBinanceDepth: boolean;
  enableBinanceTrades: boolean;
  enableLiquidations: boolean;
  enableSecondVenue: boolean;
  streamingStaleMs: number;
}

export class StreamingSupervisor {
  private orderBooks = new OrderBookManager(20);
  private health: StreamingHealthService;
  private aggregator: FeatureAggregator;
  private featureService: StreamingFeatureService;
  private binance: BinanceFuturesWsCollector;
  private secondVenue: SecondVenueWsCollector;
  private running = false;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(
    private options: StreamingSupervisorOptions,
    private store: StreamingStore,
    private symbolMap: StreamingSymbolMap
  ) {
    this.health = new StreamingHealthService(options.streamingStaleMs);
    this.aggregator = new FeatureAggregator(this.orderBooks, store, symbolMap);
    this.featureService = new StreamingFeatureService(
      this.aggregator,
      this.store,
      this.symbolMap,
      this.health,
      options.streamingStaleMs
    );

    this.binance = new BinanceFuturesWsCollector(
      {
        symbols: options.symbols,
        enableDepth: options.enableBinanceDepth,
        enableTrades: options.enableBinanceTrades,
        enableLiquidations: options.enableLiquidations
      },
      {
        onDepth: event => {
          const ok = this.orderBooks.applyDelta({
            symbol: event.symbol,
            U: event.U,
            u: event.u,
            pu: event.pu,
            bids: event.bids,
            asks: event.asks
          });
          if (!ok) {
            this.orderBooks.markResync(event.symbol);
          }
          this.health.touch('binance_depth', `${event.symbol} depth`);
        },
        onTrade: trade => {
          this.aggregator.onTrade(trade);
          this.health.touch('binance_trades', `${trade.symbol} trade`);
        },
        onLiquidation: tick => {
          this.aggregator.onLiquidation(tick);
          this.health.touch('binance_liquidations', `${tick.symbol} liquidation`);
        },
        onSnapshot: (symbol, snapshot) => {
          this.orderBooks.applySnapshot(symbol, snapshot);
          this.health.touch('binance_depth', `${symbol} snapshot`);
        },
        onHealth: (component, detail) => {
          this.health.touch(component, detail);
        },
        onError: (context, error) => {
          console.error(`[streaming] ${context}:`, error);
          if (context.includes('depth')) this.health.setDown('binance_depth', String(error));
          if (context.includes('trade')) this.health.setDown('binance_trades', String(error));
          if (context.includes('liquidation')) this.health.setDown('binance_liquidations', String(error));
        }
      }
    );

    this.secondVenue = new SecondVenueWsCollector(
      {
        symbols: options.secondVenueSymbols,
        enabled: options.enableSecondVenue
      },
      {
        onTick: tick => {
          const mapped = this.mapSecondVenueToBinance(tick.symbol);
          if (!mapped) return;
          this.aggregator.onSecondVenuePrice(mapped, tick.price, tick.timestamp);
          this.health.touch('second_venue', `${tick.symbol} ticker`);
        },
        onHealth: detail => this.health.touch('second_venue', detail),
        onError: (context, error) => {
          console.error(`[streaming] ${context}:`, error);
          this.health.setDown('second_venue', String(error));
        }
      }
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.aggregator.start();
    await this.binance.start();
    this.secondVenue.start();
    this.healthTimer = setInterval(() => this.persistHealth(), 5000);
  }

  stop(): void {
    this.running = false;
    this.binance.stop();
    this.secondVenue.stop();
    this.aggregator.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  getFeatureService(): StreamingFeatureService {
    return this.featureService;
  }

  isHealthy(): boolean {
    return this.health.isHealthy();
  }

  getHealthStates() {
    return this.health.getAll();
  }

  private persistHealth(): void {
    for (const state of this.health.getAll()) {
      this.store.upsertHealth(
        state.component,
        state.status,
        state.details,
        state.lastMessageAt > 0 ? new Date(state.lastMessageAt).toISOString() : new Date(0).toISOString()
      );
    }
  }

  private mapSecondVenueToBinance(symbol: string): string | null {
    const upper = symbol.toUpperCase();
    if (upper === 'BTC-USD') return 'BTCUSDT';
    if (upper === 'ETH-USD') return 'ETHUSDT';
    if (upper === 'SOL-USD') return 'SOLUSDT';
    return null;
  }
}

