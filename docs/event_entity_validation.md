# Event/Entity Validation

## Purpose
This layer blocks false causal mappings before they become actionable trades.

## Deterministic Guard Flow
1. Extract entities from market title/description:
- person-like names (e.g., `First Last`)
- entity hints (Fed, OPEC, NATO, key company names, `$TICKER`)
2. Validate explicit ontology evidence:
- requires real keyword evidence for the mapped asset (`matchedKeywords`).
3. Apply hard blocks:
- unknown person + legal/crime event + no known link => reject.
- no explicit keyword match + no known relationship => reject.
4. Score entity confidence and classify:
- `approved`, `needs_review`, or `rejected`.

## Offline Knowledge Sources
- `data/entity-allowlist.json`: known market-relevant people.
- `data/entity-knowledge.json`: person/entity to asset links and allowlisted macro market keywords.

## Why a Trade Was Blocked
Look at signal fields:
- `verification_status`
- `verification_reason`
- `verification_flags`
- `verification_record`

These fields are visible via API and signal detail pages.

## How It Works in Dashboard (Adam)
- `AI Top Trades` defaults to verified-only.
- Use `Show all (debug)` to include unverified/rejected candidates.
- Expanded rows show verification status/source/reason.

## Override Strategy
No global force-approve switch is enabled by default.
The only automatic fallback approval is:
- deterministic guard says `approved`
- market type is allowlisted macro/high-signal
- Claude verifier unavailable

This fallback is marked as `verification_source = guard_allowlist`.

## Debug Checklist
1. Open `/api/signals/top?include_unverified=true`.
2. Inspect `verification_reason`, `verification_flags`, and `verification_record`.
3. Confirm ontology keyword evidence exists for mapped asset.
4. If needed, update allowlist/knowledge JSON with high-confidence relationships only.
