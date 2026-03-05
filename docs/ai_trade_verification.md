# AI Trade Verification

## Overview
Signals now pass a two-stage gate before they are considered actionable:
1. Deterministic entity/relevance guard.
2. Claude CLI verification (`claude -p`) with JSON-only output.

## Claude Input Context
The verifier receives:
- market title
- odds before/now, delta, timeframe
- whale summary
- matched asset and suggested direction
- ontology keywords that triggered mapping
- reinforcing/conflicting recent signals (48h)
- deterministic guard decision snapshot

## Expected Claude JSON
```json
{
  "verdict": "approve|reject|needs_review",
  "confidence_adjustment": -20,
  "reason": "short reason",
  "flags": ["unknown_entity", "no_link"],
  "suggested_action_override": "optional"
}
```

## Fallback Behavior
If Claude fails or times out:
- default result is `needs_review` (no push).
- only allowlisted market-type fallback can auto-approve (`guard_allowlist` source), and this is explicitly flagged.

## Enforcement Points
1. Push gating (`AlertDispatcher`):
- market must be open for asset market
- confidence and delta thresholds must pass
- verification must be approved
2. Top trades (`/api/signals/top`):
- verified-only by default
- `include_unverified=true` for debug view
3. Morning brief:
- uses verified signals only

## Key Config
- `VERIFICATION_REQUIRED_FOR_PUSH=true`
- `ENTITY_CONFIDENCE_THRESHOLD=0.55`
- `UNKNOWN_PERSON_LEGAL_EVENT_POLICY=block`

## Operational Debug
1. Inspect `/api/signals/:id` for verification fields.
2. Open `/api/signals/:id/detail` to view verification rationale and decision record.
3. Use dashboard `Show all (debug)` to inspect filtered signals.

## Link to Learning Loop
Backtest outcomes are now used to update per-asset reliability and confidence adjustments daily.
See `docs/backtest_learning_system.md`.
