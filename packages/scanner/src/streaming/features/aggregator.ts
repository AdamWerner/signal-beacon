import { BinanceLiquidationTick, BinanceTradeTick } from '../collectors/binance-futures-ws.js';
import { OrderBookManager } from '../orderbook/orderbook-manager.js';
import { StreamingStore } from '../storage/streaming-store.js';
import { StreamingSymbolMap } from '../services/symbol-map.js';
import { computeMultiLevelImbalance, computeTopOfBookImbalance } from './imbalance.js';
import { computeOfiProxy } from './ofi.js';
import { computeMicroPrice, computeNormalizedMicroDivergence } from './microprice.js';
import { computeDepthDropRate, computeSpreadBps, detectLiquidityCliff } from './liquidity.js';
import { computeRealizedVolatilityPct } from './volatility.js';
import { computeLiquidationContext } from './liquidation.js';
import { FeatureSnapshot1m, FeatureSnapshot1s } from '../fusion/types.js';

interface SymbolState {
  trades: BinanceTradeTick[];
  liquidations: BinanceLiquidationTick[];
  secondVenuePrices: Array<{ timestamp: number; price: number }>;
  snapshots1s: FeatureSnapshot1s[];
  snapshots1m: FeatureSnapshot1m[];
  previousTop?: { bidPrice: number; bidSize: number; askPrice: number; askSize: number; depth10bps: number };
}

export class FeatureAggregator {
  private state = new Map<string, SymbolState>();
  private tickTimer: NodeJS.Timeout | null = null;
  private minuteCounter = 0;
  private latest1s = new Map<string, FeatureSnapshot1s>();
  private latest1m = new Map<string, FeatureSnapshot1m>();

  constructor(
    private orderBooks: OrderBookManager,
    private store: StreamingStore,
    private symbolMap: StreamingSymbolMap
  ) {}

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.captureTick(), 1000);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  onTrade(trade: BinanceTradeTick): void {
    const state = this.getState(trade.symbol);
    state.trades.push(trade);
    if (state.trades.length > 1200) {
      state.trades.splice(0, state.trades.length - 1200);
    }
  }

  onLiquidation(tick: BinanceLiquidationTick): void {
    const state = this.getState(tick.symbol);
    state.liquidations.push(tick);
    if (state.liquidations.length > 800) {
      state.liquidations.splice(0, state.liquidations.length - 800);
    }
  }

  onSecondVenuePrice(symbol: string, price: number, timestamp: number): void {
    const state = this.getState(symbol);
    state.secondVenuePrices.push({ timestamp, price });
    if (state.secondVenuePrices.length > 600) {
      state.secondVenuePrices.splice(0, state.secondVenuePrices.length - 600);
    }
  }

  getLatest1s(symbol: string): FeatureSnapshot1s | null {
    return this.latest1s.get(symbol.toUpperCase()) || null;
  }

  getLatest1m(symbol: string): FeatureSnapshot1m | null {
    return this.latest1m.get(symbol.toUpperCase()) || null;
  }

  getAllLatest1s(): FeatureSnapshot1s[] {
    return Array.from(this.latest1s.values());
  }

  private captureTick(): void {
    this.minuteCounter += 1;
    const symbols = this.orderBooks.getSymbols();
    const nowIso = new Date().toISOString();

    for (const symbol of symbols) {
      const book = this.orderBooks.getBook(symbol);
      if (!book) continue;
      const top = book.getTopLevels(10);
      const bestBid = top.bids[0] || null;
      const bestAsk = top.asks[0] || null;
      if (!bestBid || !bestAsk) continue;

      const mid = book.midPrice() || 0;
      const spread = book.spread() || 0;
      if (mid <= 0 || spread <= 0) continue;

      const state = this.getState(symbol);
      const recentTrades = state.trades.filter(trade => Date.now() - trade.timestamp <= 60_000);
      const buyQty = recentTrades
        .filter(trade => !trade.isBuyerMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const sellQty = recentTrades
        .filter(trade => trade.isBuyerMaker)
        .reduce((sum, trade) => sum + trade.quantity, 0);
      const signedTradeImbalance = buyQty - sellQty;
      const tradeIntensity = recentTrades.length;

      const topImbalance = computeTopOfBookImbalance(bestBid.size, bestAsk.size);
      const multiImbalance = computeMultiLevelImbalance(top.bids, top.asks, 10);
      const microPrice = computeMicroPrice(bestBid, bestAsk) || mid;
      const microDivergence = microPrice - mid;
      const normalizedMicroDivergence = computeNormalizedMicroDivergence(microPrice, mid, spread);
      const spreadBps = computeSpreadBps(mid, spread);
      const depth10 = book.getDepthWithinBps(10);
      const depth25 = book.getDepthWithinBps(25);
      const depth10Total = depth10.bidDepth + depth10.askDepth;
      const depth25Total = depth25.bidDepth + depth25.askDepth;
      const prevDepth10 = state.previousTop?.depth10bps ?? depth10Total;
      const depthDropRate = computeDepthDropRate(depth10Total, prevDepth10);
      const liquidityCliff = detectLiquidityCliff(depthDropRate, spreadBps);

      const mids = state.snapshots1s.slice(-120).map(snapshot => snapshot.midPrice).concat(mid);
      const shortVolatilityPct = computeRealizedVolatilityPct(mids);

      let ofi = signedTradeImbalance;
      if (state.previousTop) {
        ofi = computeOfiProxy({
          prevBidPrice: state.previousTop.bidPrice,
          prevBidSize: state.previousTop.bidSize,
          prevAskPrice: state.previousTop.askPrice,
          prevAskSize: state.previousTop.askSize,
          bidPrice: bestBid.price,
          bidSize: bestBid.size,
          askPrice: bestAsk.price,
          askSize: bestAsk.size,
          signedTradeImbalance
        });
      }

      const liquidation = computeLiquidationContext(state.liquidations, 60_000);

      const secondVenueReturn5s = this.computeSecondVenueReturn5s(state);
      const secondVenueGapBps = this.computeSecondVenueGapBps(state, mid);

      const snapshot: FeatureSnapshot1s = {
        timestamp: nowIso,
        symbol,
        topImbalance,
        multiLevelImbalance: multiImbalance,
        ofiProxy: ofi,
        microPrice,
        midPrice: mid,
        microDivergence,
        normalizedMicroDivergence,
        spreadBps,
        depth10bps: depth10Total,
        depth25bps: depth25Total,
        depthDropRate,
        liquidityCliff,
        tradeIntensity,
        signedTradeImbalance,
        shortVolatilityPct,
        liquidationBurstIntensity: liquidation.burstIntensity,
        liquidationDirection: liquidation.direction,
        liquidationClustering: liquidation.clusteringScore,
        secondVenueReturn5s,
        secondVenueGapBps
      };

      state.previousTop = {
        bidPrice: bestBid.price,
        bidSize: bestBid.size,
        askPrice: bestAsk.price,
        askSize: bestAsk.size,
        depth10bps: depth10Total
      };

      state.snapshots1s.push(snapshot);
      if (state.snapshots1s.length > 7200) {
        state.snapshots1s.splice(0, state.snapshots1s.length - 7200);
      }
      this.latest1s.set(symbol, snapshot);

      const mapping = this.findAssetIdBySymbol(symbol);
      this.store.insertFeatureSnapshot1s(snapshot, mapping);
      if (liquidityCliff) {
        this.store.insertLiquidityEvent(symbol, mapping, 'liquidity_cliff', {
          spreadBps,
          depthDropRate,
          depth10bps: depth10Total
        });
      }

      if (liquidation.direction !== 'none' && liquidation.burstIntensity > 0) {
        const recentLiq = state.liquidations[state.liquidations.length - 1];
        if (recentLiq) {
          this.store.insertLiquidationEvent(
            symbol,
            mapping,
            recentLiq.side,
            recentLiq.price,
            recentLiq.quantity,
            new Date(recentLiq.timestamp).toISOString()
          );
        }
      }
    }

    if (this.minuteCounter % 60 === 0) {
      this.captureMinuteRollups();
    }
  }

  private captureMinuteRollups(): void {
    const nowIso = new Date().toISOString();
    for (const [symbol, state] of this.state.entries()) {
      const oneMinute = state.snapshots1s.slice(-60);
      if (oneMinute.length < 10) continue;

      const avg = (values: number[]) => values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;

      const topImbalanceAvg = avg(oneMinute.map(snapshot => snapshot.topImbalance));
      const multiLevelImbalanceAvg = avg(oneMinute.map(snapshot => snapshot.multiLevelImbalance));
      const ofiAvg = avg(oneMinute.map(snapshot => snapshot.ofiProxy));
      const microDivergenceAvg = avg(oneMinute.map(snapshot => snapshot.normalizedMicroDivergence));
      const spreadBpsAvg = avg(oneMinute.map(snapshot => snapshot.spreadBps));
      const depth10bpsAvg = avg(oneMinute.map(snapshot => snapshot.depth10bps));
      const tradeIntensityAvg = avg(oneMinute.map(snapshot => snapshot.tradeIntensity));
      const signedTradeImbalanceAvg = avg(oneMinute.map(snapshot => snapshot.signedTradeImbalance));
      const shortVolatilityPctAvg = avg(oneMinute.map(snapshot => snapshot.shortVolatilityPct));

      const topImbalancePersistenceBull = oneMinute.filter(snapshot => snapshot.topImbalance > 0.12).length / oneMinute.length;
      const topImbalancePersistenceBear = oneMinute.filter(snapshot => snapshot.topImbalance < -0.12).length / oneMinute.length;
      const microDivergencePersistenceBull = oneMinute.filter(snapshot => snapshot.normalizedMicroDivergence > 0.15).length / oneMinute.length;
      const microDivergencePersistenceBear = oneMinute.filter(snapshot => snapshot.normalizedMicroDivergence < -0.15).length / oneMinute.length;

      const baseline = state.snapshots1m.slice(-120);
      const baselineImbalanceMean = avg(baseline.map(item => item.topImbalanceAvg));
      const baselineImbalanceStd = this.std(baseline.map(item => item.topImbalanceAvg), baselineImbalanceMean);
      const baselineOfiMean = avg(baseline.map(item => item.ofiAvg));
      const baselineOfiStd = this.std(baseline.map(item => item.ofiAvg), baselineOfiMean);
      const imbalanceZScore = baselineImbalanceStd > 0 ? (topImbalanceAvg - baselineImbalanceMean) / baselineImbalanceStd : 0;
      const ofiZScore = baselineOfiStd > 0 ? (ofiAvg - baselineOfiMean) / baselineOfiStd : 0;

      const regimeLabel = spreadBpsAvg > 12
        ? 'wide_spread'
        : shortVolatilityPctAvg > 0.5
          ? 'high_vol'
          : 'normal';

      const rollup: FeatureSnapshot1m = {
        timestamp: nowIso,
        symbol,
        topImbalanceAvg,
        multiLevelImbalanceAvg,
        ofiAvg,
        microDivergenceAvg,
        spreadBpsAvg,
        depth10bpsAvg,
        tradeIntensityAvg,
        signedTradeImbalanceAvg,
        shortVolatilityPctAvg,
        topImbalancePersistenceBull,
        topImbalancePersistenceBear,
        microDivergencePersistenceBull,
        microDivergencePersistenceBear,
        imbalanceZScore,
        ofiZScore,
        regimeLabel
      };

      state.snapshots1m.push(rollup);
      if (state.snapshots1m.length > 1440) {
        state.snapshots1m.splice(0, state.snapshots1m.length - 1440);
      }
      this.latest1m.set(symbol, rollup);
      this.store.insertFeatureSnapshot1m(rollup, this.findAssetIdBySymbol(symbol));
    }
  }

  private computeSecondVenueReturn5s(state: SymbolState): number {
    if (state.secondVenuePrices.length < 2) return 0;
    const latest = state.secondVenuePrices[state.secondVenuePrices.length - 1];
    const targetTs = latest.timestamp - 5_000;
    let base = state.secondVenuePrices[0];
    for (const point of state.secondVenuePrices) {
      if (point.timestamp <= targetTs) base = point;
      else break;
    }
    if (!base || base.price <= 0) return 0;
    return ((latest.price - base.price) / base.price) * 100;
  }

  private computeSecondVenueGapBps(state: SymbolState, primaryMid: number): number {
    if (primaryMid <= 0 || state.secondVenuePrices.length === 0) return 0;
    const latest = state.secondVenuePrices[state.secondVenuePrices.length - 1];
    return ((latest.price - primaryMid) / primaryMid) * 10_000;
  }

  private getState(symbol: string): SymbolState {
    const normalized = symbol.toUpperCase();
    const existing = this.state.get(normalized);
    if (existing) return existing;
    const created: SymbolState = {
      trades: [],
      liquidations: [],
      secondVenuePrices: [],
      snapshots1s: [],
      snapshots1m: []
    };
    this.state.set(normalized, created);
    return created;
  }

  private std(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    return Math.sqrt(Math.max(0, variance));
  }

  private findAssetIdBySymbol(symbol: string): string | null {
    const entries = ['crypto-coinbase', 'bitcoin', 'ethereum', 'solana'];
    for (const assetId of entries) {
      const map = this.symbolMap.getByAssetId(assetId);
      if (map?.binanceSymbol === symbol) return assetId;
    }
    return null;
  }
}

