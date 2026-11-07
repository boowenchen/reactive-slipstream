# Slipstream — storyboard (2:50 maximum)

Record after the live 200+200 benchmark. No fabricated chart or speed claim. Show
the actual JSON filename, sample counts, timeout count and configured poll interval.

| Time | Shot | English narration |
|---|---|---|
| 0:00–0:20 | Two-pool price diagram | “Two pools, one token pair, different prices. Slipstream turns reserve events into guarded trades through Reactive Omni.” |
| 0:20–0:45 | Dislocation swap and pool Sync receipt | “A real test-token swap creates the price difference on Base Sepolia. Both pools emit sequence-numbered reserve updates.” |
| 0:45–1:10 | Lasna Decision receipt; highlight origin hash and decision ID | “The Lasna contract checks the spread and quotes a round trip. Its decision carries the source transaction and log index, so we can follow this exact opportunity.” |
| 1:10–1:40 | Callback Completed receipt and token balances | “The destination verifies the proxy and reactive sender. It executes two swaps atomically, with an input cap, deadline, slippage bounds and minimum token profit. Stale quotes revert.” |
| 1:40–2:15 | Real chart, JSON rows, both sample counts | “We ran two independent fixtures: two hundred Reactive opportunities and two hundred using a polling keeper that actually sends transactions. Here are the measured median and ninety-fifth percentile results, including the failure counts.” |
| 2:15–2:35 | Expand stage distributions and show matching three receipts | “These are observer timings, including RPC polling. Cross-chain block clocks are not a precision stopwatch. Every successful sample links back to its transaction evidence.” |
| 2:35–2:50 | Mutation failure/restored pass and pause control | “The test suite catches deliberately broken safety properties. This prototype measures a mechanism; it does not claim mainnet profitability.” |

Narration: about 230 words. Read actual measured values only if available. Otherwise
replace the benchmark scene with the unexecuted runbook and state that measurement is pending.
