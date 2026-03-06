# CVCT Technical Overview (Arcium)

## Abstract

CVCT is a confidential accounting layer for Solana. It keeps balances, mint totals, and internal transfers private while preserving on-chain SPL custody through vault accounts. Confidential transitions are computed by Arcium MPC and committed back on-chain via authenticated callbacks.

## Design Goals

1. Confidential balances and private transfer amounts.
2. Publicly auditable custody of backing assets.
3. Small, composable protocol surface for integrations.
4. Deterministic and verifiable state transitions.

## Architecture

### On-chain

1. `CvctMint`: metadata + encrypted `total_supply`.
2. `Vault`: backing token account metadata + encrypted `total_locked`.
3. `CvctAccount`: per-user encrypted balance account.
4. `PendingOperation`: two-phase operation state for request/callback/settle.

### Off-chain (Arcium)

1. Arcis encrypted instructions define arithmetic/state transitions.
2. Program queues computations with encrypted inputs and nonce contexts.
3. Callback verifies signed output and writes encrypted results.

## Operational Flow

### Initialization

1. Initialize comp defs.
2. Initialize mint/vault confidential totals.
3. Initialize user confidential accounts.

### Deposit and Redeem (Two-Phase)

1. `request_deposit` or `request_redeem` creates a `PendingOperation` and queues MPC.
2. Callback applies encrypted state updates and marks operation `ComputedSuccess`/`ComputedFailure`.
3. `settle_deposit` or `settle_redeem` performs asset transfer/refund and moves operation to terminal status.

### Transfer

1. `transfer_cvct` queues encrypted transfer arithmetic.
2. callback writes updated encrypted sender/recipient balances.

### Yield Sync

1. `sync_total_assets` (authority-gated) updates encrypted `total_locked` after strategy/yield accounting.

## Security Invariants

1. Settlement cannot execute before callback-computed state is available.
2. Callback can apply only once per pending operation phase.
3. Pending operations are idempotent at terminal states.
4. Quote-verification math uses bounded operand domains for safe multiplication.
5. Vault token transfers are constrained to configured vault and backing mint accounts.

## Testing

The suite validates:

1. Deterministic share math vectors and invariants.
2. End-to-end init, request/callback/settle deposit/redeem, and transfer.
3. Race hardening: early settle rejection and terminal idempotent settle behavior.
