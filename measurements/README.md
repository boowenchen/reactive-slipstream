# Measurements

Live testnet results (2026-11-07). The ledger and analysis are in [TRANSACTIONS.md](TRANSACTIONS.md) and the main [README](../README.md#budget-and-actual-sample-counts).

| File | Content |
|---|---|
| `27cf3990-b267-476d-ab01-b8b3586a117a.json` / `.html` | Calibration run (3 Reactive + 3 keeper trials), internal `runId` 06d6ceed-5869-446d-b3fe-e52bc712c2c4 |
| `8ef50d60-a2a2-40dd-a66e-0408c426059a.json` / `.html` | Formal run (136 Reactive + 136 keeper trials), internal `runId` 41eec3d5-6d2e-42cb-84d6-48808cebda5f |

File names are the observer's output IDs; the `runId` inside each JSON is the run identifier shown in its chart.
The HTML chart plots the observer interval (origin receipt observed → completion observed). That interval is
compressed by observer polling; read the primary block-timestamp metric in the main README first.
Synthetic unit-test inputs in scripts/metrics.test.ts only verify calculations and are never benchmark evidence.
