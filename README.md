# PolySignal - Trading Intelligence System

## Quick Start
```bash
# Install
npm install

# Start API (port 3100)
npm run dev:api

# Start Dashboard
npm run dev

# Start Live Scanner
npm run start:live
```

## Architecture
- Scanner: monitors multiple data sources, generates signals, evaluates outcomes, and pushes to phone
- API: Express on `:3100`, serves dashboard data, diagnostics, and signal detail pages
- Dashboard: React + Vite, real-time monitoring for signals, pushes, and funnel visibility

## Data Sources
1. Polymarket prediction markets (odds changes + whale trades)
2. FinViz (news, insider trades, unusual volume)
3. Technical analysis (RSI, MACD, Bollinger on Yahoo Finance 1-minute bars)
4. Economic calendar (ForexFactory macro surprises)
5. Congressional and insider trading (Senate + House stock watcher)
6. RSS news feeds

## Signal Pipeline
Markets -> Odds/Catalyst Detection -> Signal Generation -> Entity Guard ->
Intelligence Enrichment -> Push Gates -> Deep Verify -> Home Assistant -> Phone

## Runtime Modes
- Active mode: tighter scan cadence with full external-catalyst coverage during market hours
- Dormant mode: slower cadence with external scanners skipped on nights/weekends
- Live mode: `DRY_RUN=false`, real push path enabled
- Test mode: force-open and dry-run commands for one-cycle validation

## Key Commands
- `npm run start:live` - production scanner (`DRY_RUN=false`)
- `npm run continuous` - same continuous scanner entrypoint
- `npm run scan` - single scan cycle
- `npm run system-test` - full health check
- `npm run test:live-cycle` - forced live-style scan cycle
- `npm run refresh:markets` - refresh tracked Polymarket markets
- `npm run refresh:instruments` - refresh Avanza instruments
- `npm run policy:optimize` - tune push thresholds from backtest data

## Dashboard Monitoring
- Top signals and Swedish focus views
- Catalyst feed and source diagnostics
- Signal funnel for the last 24 hours
- Push diagnostics and live push outcomes
- Streaming and health visibility

## Notes
- Do not commit `.env`, `data/*.db`, or `data/*.log`
- For live pushes, make sure Home Assistant env vars and `PUBLIC_URL` are configured
- Weekend dormant mode is expected to skip external catalyst scans
