# PolySignal

A TypeScript backend that monitors Polymarket prediction markets for sudden odds swings and whale activity, automatically discovers and maps relevant Avanza bull/bear certificates, and surfaces trade suggestions through a React dashboard and push alerts.

## Critical Design Principle: Full Auto-Discovery

This system discovers **EVERYTHING** automatically. The operator never needs to manually enter Polymarket market slugs or Avanza instrument IDs. The system:

1. **Scrapes Polymarket** via the Gamma API to find all active, financially-relevant markets
2. **Scrapes Avanza** via the authenticated API to build a live registry of all bull/bear certificates
3. **Automatically maps** Polymarket markets to Avanza instruments through an underlying asset ontology
4. **Auto-maintains** both registries — adding new instruments/markets, archiving resolved/delisted ones

The **ONLY** thing provided manually is the **underlying asset ontology** (in `data/ontology.json`) — the knowledge that "Federal Reserve" relates to "S&P 500" relates to Avanza search term "SP500".

## Architecture

```
polysignal/
├── packages/
│   ├── dashboard/      # React + Vite + Tailwind UI
│   ├── scanner/        # Core monitoring & discovery logic
│   └── api/            # Express REST API
├── data/
│   ├── ontology.json   # The human knowledge layer
│   └── polysignal.db   # SQLite database (auto-created)
└── scripts/            # Setup & manual triggers
```

## Quick Start

### 1. Prerequisites

- Node.js 18+
- Avanza account with TOTP/2FA configured

### 2. Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your Avanza credentials

# Build packages
npm run build
```

### 3. Configure Avanza Credentials

Edit `.env`:

```env
AVANZA_USERNAME=your_username
AVANZA_PASSWORD=your_password
AVANZA_TOTP_SECRET=your_totp_secret
```

**Getting TOTP Secret:**
1. Go to Avanza > Profil > Inställningar > Tvåfaktorsinloggning
2. Enable TOTP/Authenticator app
3. Save the secret key (used to generate codes)

### 4. Run

```bash
# Start API server + scanner (runs scheduled jobs)
npm run dev:api

# In another terminal, start dashboard
npm run dev

# Or start both together
npm run dev:all
```

- Dashboard: http://localhost:8080
- API: http://localhost:3100

## Scheduled Jobs

The scanner runs four automated jobs:

| Job | Frequency | What it does |
|-----|-----------|--------------|
| **Scan Cycle** | Every 15 min | Tracks odds, detects whales, generates signals |
| **Market Refresh** | Every 6 hours | Discovers new Polymarket markets via Gamma API |
| **Instrument Refresh** | Daily at 06:00 | Refreshes Avanza certificate registry |
| **Cleanup** | Daily at 03:00 | Archives resolved markets, old data |

## Manual Operations

```bash
# Refresh Avanza instruments (discovers new certificates)
npm run refresh:instruments

# Refresh Polymarket markets (discovers new markets)
node scripts/refresh-markets.js

# Trigger a scan cycle manually
npm run scan
```

## API Endpoints

```
GET  /api/signals                    # All signals, newest first
GET  /api/signals/:id                # Single signal detail
GET  /api/markets                    # All tracked Polymarket markets
GET  /api/markets/:conditionId/odds  # Odds history for a market
GET  /api/instruments                # Avanza certificate registry
GET  /api/instruments/search?q=      # Search certificates
GET  /api/correlations               # Auto-mapped correlations (computed)
GET  /api/ontology                   # Current ontology
GET  /api/whales                     # Whale events feed
GET  /api/health                     # Scanner status, job schedules
POST /api/scan/trigger               # Manual scan trigger
POST /api/refresh/markets            # Manual market refresh
POST /api/refresh/instruments        # Manual instrument refresh
```

## Technologies Used

- **Backend**: TypeScript, Node.js, Express
- **Database**: SQLite (better-sqlite3)
- **Frontend**: React, Vite, shadcn-ui, Tailwind CSS
- **APIs**: Polymarket Gamma API, Avanza API (via avanza npm package)
- **Job Scheduling**: node-cron
- **Alerts**: Pushover, Webhooks
