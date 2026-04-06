# CVCT - Confidential Vault-Backed Claim Token

CVCT is a private yield treasury rail for Solana.

Today, the codebase implements a confidential, vault-backed accounting system that can:

- accept deposits of a backing SPL asset into protocol custody
- maintain private per-user balances and private global accounting via Arcium MPC
- settle deposit and redeem flows with staged commits rather than immediate callback mutation
- deploy idle treasury assets into Kamino inline during deposit settlement
- pull buffered liquidity from Kamino inline during low-idle redeem settlement

The direction is intentional:

- `private yield` is the product
- `MPC` is an enabling layer for private accounting and controlled workflows

## What CVCT does today

CVCT lets a treasury issue a confidential claim on a backing SPL asset while keeping internal balances private.

In practical terms, the current system already fits:

- private treasury balances
- private sub-accounting for teams, desks, or beneficiaries
- private payroll or grant distribution balances
- yield deployment of idle assets through an onchain treasury adapter

The protocol is built around four ideas:

- `Vault-backed`: real SPL assets sit in a Solana token account controlled by the protocol vault PDA
- `Confidential accounting`: user balances, total supply, and total assets are stored as encrypted state
- `Staged commit`: deposit and redeem computations stage results first, then commit canonical state only during settlement
- `Optimistic concurrency`: stale operations invalidate instead of overwriting newer pricing or balance state

## Product direction

The highest-value use case for this codebase is:

- private yield-bearing treasury accounts for DAOs, teams, funds, payroll operators, and on-chain businesses

That means the protocol should be described and evolved as:

- a private treasury rail
- a private payroll / grants rail
- a confidential internal balance system with explicit yield deployment

## Current protocol shape

### Deposit

1. `request_deposit_intent` records a deposit intent and queues Arcium computation.
2. `deposit_and_mint_callback` writes a staged result only.
3. `settle_deposit_commit` transfers backing assets into the vault, optionally deploys excess idle liquidity into Kamino, and commits the staged confidential state.

Operationally, this is treasury funding into private balances, not just minting a token.

### Redeem

1. `request_redeem_intent` records a redeem intent and queues Arcium computation.
2. `burn_and_withdraw_callback` writes a staged result only.
3. `settle_redeem_commit` pays assets out of the vault, auto-pulling buffered liquidity from Kamino when idle liquidity is short, and commits the staged confidential burn state.

Operationally, this is private balance redemption back into spendable assets.

### Transfer

1. `transfer_cvct` queues confidential transfer computation.
2. `transfer_cvct_callback` commits sender and recipient balance updates only if both account versions still match.

This is the internal movement primitive for private allocations, payroll balances, grants, or desk-to-desk transfers.

### Treasury / Kamino

Kamino is now wired into the settlement instructions that naturally own liquidity transitions:
- deposit settle can deploy excess idle liquidity into Kamino
- redeem settle can pull buffered liquidity back from Kamino when the idle vault is short

The protocol still exposes explicit treasury instructions:

- `configure_kamino_adapter`
- `update_kamino_policy`
- `kamino_deposit_idle`
- `kamino_withdraw_to_vault`
- `rebalance_idle_liquidity`
- `sync_total_assets_from_adapter`

The active policy is:
- keep a configurable idle liquidity threshold in the vault
- deploy only excess idle liquidity into Kamino on deposit settle
- pull `deficit + redeem buffer` from Kamino on low-idle redeem settle

New adapters default to a `10_000` BPS idle threshold, so enabling Kamino does not auto-deploy funds until policy is explicitly updated.

Manual instructions remain available as operator escape hatches and testing tools.

## Core safety properties

- Deposit and redeem do not mutate canonical confidential state in callbacks.
- Settlement is blocked until callback-visible staged state exists.
- Stale staged operations invalidate if pricing state changed.
- Stale staged operations invalidate if the user's balance changed.
- Deposit settlement reverts atomically if inline Kamino deployment is required and fails.
- Redeem settlement reverts atomically if inline Kamino withdrawal cannot satisfy the payout.
- Failed transfers do not mutate canonical balances or versions.
- No-op syncs do not invalidate staged operations.
- Operation-purpose PDAs can be explicitly cleaned up after terminal completion.

These properties matter because CVCT is trying to be a reliable private treasury ledger, not only a private balance gadget.

## Main accounts

- `CvctMint`: encrypted total supply and backing mint metadata
- `Vault`: encrypted total locked assets and backing token vault authority
- `PricingState`: monotonic pricing version for stale-op invalidation
- `CvctAccount`: per-user encrypted balance and balance version
- `PendingOperation`: request lifecycle state for deposit and redeem
- `PendingDepositResult`: staged deposit result
- `PendingRedeemResult`: staged redeem result
- `PendingTransferResult`: staged transfer result
- `KaminoAdapterState`: Kamino wiring plus idle-threshold and redeem-buffer policy

## Repository layout

- `programs/cvct/`: Anchor program
- `encrypted-ixs/`: Arcium encrypted instruction circuits
- `tests/`: split integration suite
- `docs/`: architecture, flow, treasury, and testing notes
- `tests/fixtures/kamino/`: local Kamino artifacts used by integration tests

## Local development

### Build

```bash
arcium build
```

### Test tiers

```bash
yarn test
```

Runs the smoke suite only.

```bash
yarn test:cvct
```

Runs smoke + lifecycle + races.

```bash
CVCT_RUN_KAMINO_LOCAL=1 yarn test:kamino
```

Runs Kamino integration only.

```bash
CVCT_RUN_KAMINO_LOCAL=1 arcium test
```

Runs the full gate used for end-to-end local validation.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): protocol architecture and state model
- [`docs/flows.md`](docs/flows.md): deposit, redeem, transfer, sync, and cleanup flows
- [`docs/kamino-adapter.md`](docs/kamino-adapter.md): treasury adapter design and local Kamino notes
- [`docs/testing.md`](docs/testing.md): suite layout, commands, and debugging guidance

## Status

The codebase is in a strong implementation state for the current direction:

- staged-commit deposit and redeem are implemented
- pricing-version and balance-version invalidation are in place
- manual Kamino treasury integration is working
- the split local integration suite is green

The main product gap is not protocol correctness. It is finishing the private treasury and payroll framing around the current primitives, then layering stronger privacy features over time.
