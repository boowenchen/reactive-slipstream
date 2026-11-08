# Deployment runbook

**Status: executed on testnet on 2026-11-07.** This runbook was written before deployment and is kept as the procedure. Actual addresses, transactions and results are in [README.md](README.md).

All commands below were prepared for a funded testnet session. No account or wallet is
created by this project. Use a dedicated project wallet; export `PRIVATE_KEY` in the
process environment through your secret manager. Never paste it into command arguments,
logs, this README, or version control. `OWNER` must match that key.

## Setup and configuration

```powershell
python tools/bootstrap.py
./tools/test.ps1
$env:OWNER = '<project-wallet-address>'
# Set PRIVATE_KEY securely in this process, without echoing it.
$env:REACTIVE_FUND_WEI = '1000000000000000000' # 1 lREACT starting balance
$env:CALLBACK_FUND_WEI = '20000000000000000'  # 0.02 destination test ETH
```

The wrapper reads chain IDs/RPCs/proxies from `config/networks.json` and checks
the connected chain before starting a broadcast. RPC overrides are `BASE_RPC`,
`LASNA_RPC`, `UNICHAIN_RPC`, `SEPOLIA_RPC`. There are no mainnet configurations.
Without `-Broadcast`, the wrapper performs Foundry simulation only. The commands
below explicitly show `-Broadcast` to make the future transaction steps unambiguous.

After **every** stage, copy deployed addresses from Foundry's receipt into the named
environment variables and your local `config/deployed.json`; retain its transaction
hash, chain ID, block hash, constructor arguments and contract address. `broadcast/`
contains public deployment receipts but is ignored by default. For interrupted
broadcasts, inspect receipts/nonces first; use Foundry `--resume` for a known pending
broadcast. Do not blindly start a second creation. Once receipts are reconciled,
setting each existing address lets its stage skip creation. Partial stages require
setting *all* addresses already created. Address checks are consistency checks, not
bytecode attestation: verify bytecode/constructor parameters before reusing an address.

## Gas and fee funding

These are starting allocations, not measured quotes. Read gas prices and estimate
each deployment before sending. Keep both reactive contract and callback recipient
funded. A positive debt stops new delivery even if the balance appears adequate.

Read-only checks (PowerShell; use `cast` from the same Foundry bin directory):

```powershell
cast chain-id --rpc-url $env:LASNA_RPC
cast gas-price --rpc-url $env:LASNA_RPC
cast call $env:SYSTEM '_gasPriceCoeffPer1000()(uint256)' --rpc-url $env:LASNA_RPC
cast call $env:SYSTEM '_extraGas()(uint256)' --rpc-url $env:LASNA_RPC
cast call $env:SYSTEM 'debt(address)(uint256)' $env:REACTIVE --rpc-url $env:LASNA_RPC
cast call $env:PROXY 'debt(address)(uint256)' $env:RECIPIENT --rpc-url $env:BASE_RPC
```

Set `SYSTEM` to `lasna.callbackProxy`, `PROXY` to `base.callbackProxy`, and RPC env
variables from the checked-in config. `RECIPIENT` means VAULT or EXECUTOR below.
The fee model and live coefficient reads are documented in [SOURCES.md](SOURCES.md).
The source-native balance funds payer callbacks; token principal stays separate.
For later fee top-ups, `depositTo(address)` on the appropriate system/proxy credits
reserves and clears debt. Record each top-up hash. Do not send fee ETH to the token.

If test lREACT is needed, the official faucet exchanges test ETH at 1:100;
0.02–0.1 test ETH yields 2–10 lREACT. See the official faucet instructions linked
from SOURCES; funding is not performed here. Cron costs accumulate while subscribed.

## Evidence acceptance

Record deployment, linking, seed/funding, source stimulus, Reactive decision, callback,
and any pause/unsubscribe transaction hashes. Fill three complete rows in README and
`config/evidence.json` with real explorer links. Verify receipt success and emitted
application events, not merely a successful outer proxy transaction: callbacks can
fail internally while the outer transaction succeeds. Read balances/state afterwards.
No unfilled row is evidence, and local mock tests do not count as a live loop.

## Slipstream stages

Suggested wallet allocations: Base Sepolia **0.1–0.3 ETH** for two independent
fixtures, 400 origin swaps, 200 keeper trades and callback reserves; Lasna **5–10
lREACT** for subscriptions and reactive executions. Start with 1 lREACT in the
reactive contract and 0.02 test ETH in Executor; inspect real gas/fees and top up
before the 200-sample run. This is budgeting headroom, not measured consumption.
All trading inventory is fixed-supply demo tokens minted by deployment.

```powershell
$env:AMOUNT_WEI = '1000000000000000000000' # 1000 tokens, fixed per trade
$env:MIN_PROFIT_WEI = '1000000000000000000' # 1 token0, before gas
$env:SPREAD_BPS = '50'
$env:SLIPPAGE_BPS = '100'
$env:TTL_SECONDS = '120'
./tools/deploy.ps1 -Step pools -Network base -Broadcast
$env:TOKEN0 = '<A token>'
$env:TOKEN1 = '<B token>'
$env:POOL0 = '<first pool>'
$env:POOL1 = '<second pool>'
./tools/deploy.ps1 -Step reactive -Network lasna -Broadcast
$env:REACTIVE = '<Reactive contract>'
./tools/deploy.ps1 -Step executor -Network base -Broadcast
$env:EXECUTOR = '<Executor>'
./tools/deploy.ps1 -Step link -Network lasna -Broadcast
./tools/deploy.ps1 -Step seed -Network base -Broadcast
```

Seed only **after** linking. Wait until Reactive `reserves(0)` and `reserves(1)`
contain both initial states; benchmark preflight checks this. If seeding happened
before the subscription existed, a tiny real swap on each pool will emit a fresh Sync.
Record those recovery stimulus hashes. An initialized pool cannot be seeded twice.

Copy these five Base addresses into `reactiveFixture` in config/deployed.json and
the Lasna address into `reactive`. Build a separate keeper fixture in a fresh process
environment: unset TOKEN0/TOKEN1/POOL0/POOL1/EXECUTOR; preserve OWNER and numeric
parameters. Do not create another Reactive contract for the keeper fixture.

```powershell
./tools/deploy.ps1 -Step pools -Network base -Broadcast
# Set TOKEN0, TOKEN1, POOL0 and POOL1 to the newly created addresses.
./tools/deploy.ps1 -Step keeper -Network base -Broadcast
$env:EXECUTOR = '<KeeperBaseline address>'
./tools/deploy.ps1 -Step seed -Network base -Broadcast
```

Copy the new addresses into `keeperFixture`. The baseline accepts only its owner;
the real Executor accepts only proxy + authorized reactive address. Funding and
pool inventory are intentionally separate so the two engines do not race.

## Real measurement (future execution only)

```powershell
npm ci --ignore-scripts --cache .npm-cache
npm run typecheck
npm test
Copy-Item config/deployed.example.json config/deployed.json # only before filling addresses
# Fill all deployed addresses; leave samplesPerMode=200.
npm run measure                            # prints help; does not transact
npm run measure -- --execute-testnet       # sends actual testnet transactions
npm run report -- measurements/<run-id>.json
```

The benchmark sends 200 **real price-dislocation swaps** per mode. It solves for
alternating price targets relative to the other pool, rather than swapping a fixed
size that can simply undo the previous signal. It then matches Reactive Decision to
the exact origin hash and log index, and matches Completed to its decision ID. The
keeper actually polls quotes and sends trades at the configured 2-second cadence;
initial polling phase is randomized. Both use the same observer polling interval.

Rows are saved before submission and after each known hash. On interruption, pending
rows require manual receipt reconciliation; never resend an ambiguous transaction.
`npm run measure -- --execute-testnet --resume measurements/<run-id>.json` skips
recorded rows. Only resume after all prior callbacks are settled; recreate both
fixtures for a clean full 200+200 comparison after a contaminated/interrupted run.
No failed sample is replaced or relabeled successful. An incomplete sample stops
the run so late callbacks cannot affect later trials.

The JSON contains stage observation times, origin/reactive/callback hashes, block
timestamps/hashes and token profit. p50/p95 use nearest rank over successful rows,
with denominators and failures shown. Observer timings include RPC latency/polling;
cross-chain block clocks are not treated as synchronized. Same-chain source-to-
callback timestamp deltas are provided separately with second resolution. Two Base
confirmations are checked; this is not L1 finality or a universal reorg guarantee.
No speed advantage is claimed until the results exist. No legacy-Reactive baseline
is implemented: the required comparison here is the actual polling keeper.

At demo end, pause Executor and unsubscribe Reactive; use process `ETH_PRIVATE_KEY`
as in Heartbeat, or your wallet's secure signer. Record both hashes:

```powershell
cast send $env:EXECUTOR 'setPaused(bool)' true --rpc-url $env:BASE_RPC
cast send $env:REACTIVE 'setEnabled(bool)' false --rpc-url $env:LASNA_RPC
```

Set EXECUTOR back to the Reactive fixture before these commands. Paused executors
can withdraw test inventory using `withdraw(address,uint256)`. The pools have fixed,
nonredeemable demo liquidity; this is not a deployable public AMM/LP product.

### Observer interpretation

Reactive and destination event scans run concurrently. If RPC observation sees the
callback before the reactive event, the raw ordering is retained and counted;
negative stage intervals are excluded from that stage's percentile (its `n` reports
the denominator). End-to-end successful observations remain included. This benchmark
starts the keeper's randomized polling phase after the origin receipt is observed;
it measures this specified confirmed-origin polling implementation, not the fastest
possible mempool/streaming keeper. Receipt lookup and setup time are included in the
observer overhead. Do not generalize a result to all keepers or claim sub-poll-interval
protocol precision. The same-chain block-time metric provides a separate coarse check.

## Actual bounded measurement protocol

Three calibration trials per mode completed before budgeting. Calibration used a receipt-waiting forge broadcaster and is reported separately. The formal run uses viem RPC observation with an offline forge signer (the Node process never receives a private key), concurrent origin observation and concurrent keeper submission. Cache settlement is checked before the next trial; application `completed(id)` is read after every completion. The same fixtures continue from the settled calibration state with `startIndex=3`, preserving alternating price targets. They remain independent per mode; this is not a fresh-liquidity run.

Both modes use observerPollMs=500 and keeperPollMs=2000. Actual sample counts, budget formula, JSON, percentiles and charts are linked from README. Budget is evaluated using all three Reactive executions per round (decision plus two execution-induced Sync updates). The official Base RPC permits at most 200 blocks per log request, so scans are chunked. The intended denominator is configured rather than hard-coded to 200. No missing/failed row is replaced.
