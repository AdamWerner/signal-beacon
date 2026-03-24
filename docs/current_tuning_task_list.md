# Current Tuning Task List

## Goal
Tighten intraday signal quality while preserving the parts of the system that are already working.

## Workstreams
1. Coinbase clustering control
   - Separate circular crypto proxy markets from real catalysts
   - Penalize repeated proxy ladders across and within scan cycles
   - Verify that push gating still blocks weak Coinbase noise without hiding real crypto catalysts

2. Source-family-driven push policy
   - Use `source_family_diagnostics` as a real gate, not just a confidence nudge
   - Require stronger evidence when a source family is historically weak
   - Preserve overrides only for unusually strong setups

3. Swedish catalyst coverage
   - Improve Swedish Focus using catalyst-derived proxy opportunities
   - Prefer OMX/Saab/SSAB/Boliden proxy logic over looser ontology matches
   - Keep direct Swedish signals ranked ahead of proxy items

## Test Loop
1. Build scanner, API, and dashboard
2. Run scanner tests
3. Run controlled DRY_RUN scan(s)
4. Aggregate signals across runs by:
   - asset
   - source family
   - market title cluster
   - approval / push eligibility
5. Fix the next 1-5 issues found
6. Stop only after two consecutive clean runs
