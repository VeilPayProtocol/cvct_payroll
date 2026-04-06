# Testing

## Test suite layout

The suite is intentionally split by purpose.

### Smoke
File:
- `tests/cvct.smoke.ts`

Covers:
- math vectors
- init
- one happy deposit
- one happy redeem
- one happy transfer
- zero-amount guards
- invariant sanity

Use this for fast local iteration.

### Lifecycle
File:
- `tests/cvct.lifecycle.ts`

Covers:
- callback staging behavior
- early-settle rejection
- invalid quote failure
- cancel / expire
- idempotent settle behavior
- cleanup success and cleanup rejection

### Races
File:
- `tests/cvct.races.ts`

Covers:
- competing operation invalidation
- changed-sync invalidation
- transfer-vs-staged-op invalidation
- overlapping transfer snapshots
- failed transfer behavior
- cleanup for invalidated operations

### Kamino adapter
File:
- `tests/kamino_adapter.ts`

Covers:
- adapter config
- invalid wiring rejection
- inline deposit rebalance
- manual deposit / withdraw escape hatches
- disabled adapter behavior
- buffered low-liquidity redeem auto-withdraw
- adapter sync behavior

## Commands

### Smoke only
```bash
yarn test
```

### Full CVCT without Kamino
```bash
yarn test:cvct
```

### Kamino only
```bash
CVCT_RUN_KAMINO_LOCAL=1 yarn test:kamino
```

### Full local gate
```bash
CVCT_RUN_KAMINO_LOCAL=1 arcium test
```

## Why the suite is not cheap

The expensive part is not TypeScript itself. It is the local integration stack:
- Solana local validator
- Arcium nodes
- callback-visible MPC flows
- Kamino CPI setup and treasury movement

That means many tests are waiting on:
- computation finalization
- callback-observable state
- canonical balance or settlement visibility

The suite is intentionally integration-heavy because the protocol’s hardest bugs are sequencing and concurrency bugs.

## Helper structure

The helpers are split by responsibility.

### `tests/helpers/cvctEnv.ts`
Environment and fixture creation.

### `tests/helpers/cvctFlows.ts`
Flow helpers and scenario builders.

### `tests/helpers/cvctAssertions.ts`
Polling, fetchers, and assertions.

### `tests/helpers/cvctCore.ts`
Shared low-level implementation behind the public helper surface.

## Debugging options

### RPC logs
```bash
CVCT_DEBUG_RPC_LOGS=1 yarn test:cvct
```

### Timing output
```bash
CVCT_DEBUG_TIMINGS=1 yarn test:cvct
```

## Practical guidance

Use this default workflow:

1. `yarn test` while iterating on straightforward logic
2. `yarn test:cvct` before pushing protocol changes
3. `CVCT_RUN_KAMINO_LOCAL=1 arcium test` before merge or release-level validation

## Cleanup testing rule

Cleanup tests should prove success by:
- account closed
- lamports returned to owner

They should not prove cleanup by sending a second instruction against a closed PDA. That tends to produce transport noise rather than useful signal.
