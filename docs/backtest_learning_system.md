# Backtest + Daily Learning System

## Goal
Evaluate real market reaction after each verified signal (especially pushed signals), then feed that learning back into confidence calibration and push quality.

## What Runs Automatically
- In `scripts/continuous-scan.js`, close-time backtests run once per market/day:
- Swedish market: near `17:30` Stockholm time
- US market: near `22:00` Stockholm time

## Data Captured
Tables (SQLite):
- `signal_outcomes`: per-signal post-event reaction (10m/30m/60m, favorable/adverse peaks, correctness)
- `daily_backtest_runs`: one summary row per `date + market`
- `asset_performance`: rolling 21-day reliability and suggested confidence adjustment per asset

Signals now also track push timing:
- `signals.push_sent_at`
- `signals.push_channel`

## How Scoring Works
For each candidate signal:
1. Entry time = `push_sent_at` if available, else signal creation timestamp.
2. Pull 1-minute market data for 60 minutes after entry (Yahoo chart API).
3. Compute directional moves:
- `move_10m_pct`
- `move_30m_pct`
- `move_60m_pct`
- favorable/adverse peak over 60m
4. Correctness labels:
- `direction_correct_30m` (directional move > 0.2%)
- `direction_correct_60m` (directional move > 0.25%)

## Self-Improvement Loop
After each daily run:
1. Update `asset_performance` from last 21 days.
2. Derive `suggested_confidence_adjustment` per asset (bounded conservative range).
3. Next scan cycles apply this adjustment on top of base confidence + intelligence boost.

This creates a daily feedback loop without requiring cloud infrastructure.

## Claude Support
At the end of each daily backtest run, an optional Claude summary is generated and stored in:
- `daily_backtest_runs.ai_notes`

This note gives concise tactical guidance for next-day tuning.

## Operational Endpoints
- `GET /api/backtest/runs`
- `GET /api/backtest/outcomes`
- `GET /api/backtest/performance`
- `POST /api/backtest/run/:market`

## Push Quality Tightening
Intraday HA push gating is stricter now:
- higher confidence floor (configurable)
- stronger delta filter
- required verification score floor

This supports your goal: intraday pushes should be rare, high-conviction call-to-action alerts.
