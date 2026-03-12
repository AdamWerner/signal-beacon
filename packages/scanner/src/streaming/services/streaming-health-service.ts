export type StreamComponent =
  | 'binance_depth'
  | 'binance_trades'
  | 'binance_liquidations'
  | 'second_venue';

export interface StreamHealthState {
  component: StreamComponent;
  status: 'healthy' | 'degraded' | 'down';
  lastMessageAt: number;
  lastReconnectAt: number;
  reconnects: number;
  details: string;
}

export class StreamingHealthService {
  private states = new Map<StreamComponent, StreamHealthState>();
  private staleMs: number;

  constructor(staleMs: number) {
    this.staleMs = staleMs;
  }

  touch(component: StreamComponent, details = ''): void {
    const current = this.states.get(component);
    this.states.set(component, {
      component,
      status: 'healthy',
      lastMessageAt: Date.now(),
      lastReconnectAt: current?.lastReconnectAt || 0,
      reconnects: current?.reconnects || 0,
      details
    });
  }

  setDown(component: StreamComponent, details: string): void {
    const current = this.states.get(component);
    this.states.set(component, {
      component,
      status: 'down',
      lastMessageAt: current?.lastMessageAt || 0,
      lastReconnectAt: current?.lastReconnectAt || 0,
      reconnects: current?.reconnects || 0,
      details
    });
  }

  markReconnect(component: StreamComponent, details = ''): void {
    const current = this.states.get(component);
    this.states.set(component, {
      component,
      status: 'degraded',
      lastMessageAt: current?.lastMessageAt || 0,
      lastReconnectAt: Date.now(),
      reconnects: (current?.reconnects || 0) + 1,
      details
    });
  }

  getComponent(component: StreamComponent): StreamHealthState | null {
    const state = this.states.get(component);
    if (!state) return null;

    if (state.lastMessageAt > 0 && Date.now() - state.lastMessageAt > this.staleMs) {
      return {
        ...state,
        status: 'degraded',
        details: `stale for ${(Date.now() - state.lastMessageAt) / 1000}s`
      };
    }

    return state;
  }

  getAll(): StreamHealthState[] {
    return (['binance_depth', 'binance_trades', 'binance_liquidations', 'second_venue'] as StreamComponent[])
      .map(component => this.getComponent(component))
      .filter((state): state is StreamHealthState => !!state);
  }

  isHealthy(required: StreamComponent[] = ['binance_depth', 'binance_trades']): boolean {
    for (const component of required) {
      const state = this.getComponent(component);
      if (!state) return false;
      if (state.status === 'down') return false;
      if (state.lastMessageAt <= 0) return false;
      if (Date.now() - state.lastMessageAt > this.staleMs) return false;
    }
    return true;
  }
}

