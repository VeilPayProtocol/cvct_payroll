# Architecture

## Overview

CVCT is a confidential vault-backed token protocol for Solana.

It separates three concerns:
- `Custody`: real SPL assets live in vault-controlled token accounts on Solana
- `Accounting`: balances and global totals are encrypted and updated through Arcium MPC
- `Settlement`: canonical confidential state only commits when the corresponding custody step succeeds

That separation is the core architectural decision in this codebase.

## Design principles

### 1. Canonical state must not move early
Callbacks stage results. They do not directly commit user-facing accounting state for deposit and redeem.

### 2. Stale work should invalidate, not overwrite
If pricing or user balance changed underneath a staged operation, the operation becomes invalid instead of clobbering newer state.

### 3. Treasury logic should stay outside user hot paths
Kamino treasury deployment is explicit and manual. It is not embedded inside deposit or redeem settlement.

### 4. Cleanup should be explicit
Operation-purpose PDAs remain inspectable after terminal completion and can then be closed permissionlessly with rent returned to the operation owner.

## High-level component model

```mermaid
flowchart LR
    User["User"] --> Program["CVCT Anchor program"]
    Program --> Arcium["Arcium MPC"]
    Program --> Vault["Vault custody (SPL tokens)"]
    Program --> State["Encrypted state accounts"]
    Program --> Kamino["Kamino adapter (manual treasury)"]
```

## Main accounts

### `CvctMint`
Confidential mint metadata.

Holds:
- backing SPL mint reference
- encrypted `total_supply`
- nonce for encrypted supply

### `Vault`
Confidential asset backing metadata.

Holds:
- backing SPL mint
- vault authority / vault token routing context
- encrypted `total_locked`
- nonce for encrypted locked assets

### `PricingState`
Global optimistic concurrency guard for price-sensitive operations.

Holds:
- `cvct_mint`
- `pricing_version`

`pricing_version` increments only when canonical pricing state changes, such as:
- successful deposit commit
- successful redeem commit
- changed `sync_total_assets`
- changed `sync_total_assets_from_adapter`

No-op sync does not increment it.

### `CvctAccount`
Per-user confidential account.

Holds:
- owner
- mint reference
- encrypted balance
- nonce for encrypted balance
- `balance_version`

`balance_version` is the per-account concurrency guard used to prevent transfers or staged operations from overwriting newer user balance state.

### `PendingOperation`
Shared request lifecycle account for deposit and redeem.

Holds:
- operation identity and routing metadata
- operation kind (`Deposit` or `Redeem`)
- status
- staged outcome summary (`ok`, `amount_out`, `computed_at_slot`)
- concurrency snapshots:
  - `base_pricing_version`
  - `base_user_balance_version`

### `PendingDepositResult`
Staged deposit output.

Holds:
- staged encrypted user balance
- staged encrypted total supply
- staged encrypted total locked
- `shares_out`
- callback metadata
- version snapshots used to validate staleness

### `PendingRedeemResult`
Staged redeem output.

Same pattern as `PendingDepositResult`, but stores `assets_out`.

### `PendingTransferResult`
Staged transfer output.

Holds:
- initiating user
- sender and recipient account identities
- staged sender/recipient balances
- callback result flag
- base sender/recipient balance versions

### `KaminoAdapterState`
Manual treasury adapter configuration.

Holds:
- mint reference
- Kamino vault state and required PDA addresses
- KLend program reference
- enable/disable flag

The adapter is Kamino-specific. The code now treats Kamino program identity as pinned, not operator-configurable.

## Deposit architecture

```mermaid
sequenceDiagram
    participant U as User
    participant P as CVCT program
    participant A as Arcium
    participant V as Vault

    U->>P: request_deposit_intent
    P->>A: queue deposit_and_mint computation
    A-->>P: deposit_and_mint_callback
    P-->>P: stage PendingDepositResult only
    U->>P: settle_deposit_commit
    P->>V: transfer backing assets into vault
    P-->>P: commit canonical encrypted state
```

### Why this matters
The old "move funds first, compute later" pattern creates unresolved custody windows.

The current deposit path avoids that:
- request records intent only
- callback stages output only
- settlement commits custody and accounting together

## Redeem architecture

```mermaid
sequenceDiagram
    participant U as User
    participant P as CVCT program
    participant A as Arcium
    participant V as Vault

    U->>P: request_redeem_intent
    P->>A: queue burn_and_withdraw computation
    A-->>P: burn_and_withdraw_callback
    P-->>P: stage PendingRedeemResult only
    U->>P: settle_redeem_commit
    P->>V: transfer backing assets to user
    P-->>P: commit canonical encrypted burn state
```

### Low-liquidity redeem handling
A redeem can reach `ComputedSuccess` while idle vault liquidity is insufficient.

In that case:
- settlement returns `InsufficientIdleLiquidity`
- canonical confidential state does not change
- treasury can withdraw liquidity from Kamino
- settlement can be retried safely

## Transfer architecture

Transfer stays simpler than deposit and redeem:
- request transfer computation
- callback writes the result if both sender and recipient account versions still match
- stale callbacks are ignored instead of overwriting newer balances

Failed transfers:
- record `ok = false` in `PendingTransferResult`
- do not mutate canonical balances
- do not bump `balance_version`

## Concurrency model

CVCT uses optimistic concurrency at two layers.

### Pricing concurrency
Used for price-sensitive operations.

Guard account:
- `PricingState.pricing_version`

Deposit and redeem requests snapshot the current pricing version. Callback and settlement invalidate if the live version no longer matches.

### User balance concurrency
Used for same-user balance mutation safety.

Guard field:
- `CvctAccount.balance_version`

Deposit and redeem requests snapshot the user's current balance version. Transfer snapshots sender and recipient versions. Callback or settlement invalidates when the live version changed underneath the staged result.

## Cleanup model

Terminal operation accounts are closed explicitly.

Instructions:
- `cleanup_terminal_deposit`
- `cleanup_terminal_redeem`
- `cleanup_transfer_result`

Behavior:
- cleanup is permissionless
- lamports return to the operation owner
- PDAs remain inspectable until cleanup is called

This keeps operational introspection and rent recovery separate.

## Events

The program emits three main lifecycle events:
- `OperationRequestedEvent`
- `OperationComputedEvent`
- `OperationSettledEvent`

They are useful for off-chain indexing, but the account state remains the source of truth.

## Share math

The protocol uses share-based accounting with virtual offsets.

Conceptually:
- deposits mint shares from assets
- redeems burn shares into assets
- the exchange rate is based on encrypted `total_supply` and `total_locked`

The circuit verifies the caller/backend quote against the confidential state rather than trusting it blindly.

## What the architecture is optimized for

- privacy of user balances and supply movements
- deterministic settlement semantics
- safe invalidation of stale work
- explicit treasury management
- testable, decomposed lifecycle behavior

## What it does not optimize for yet

- minimum-UX public APIs (`min_out`-only user surface is still future work)
- automatic treasury rebalancing
- minimal local integration runtime

Those are follow-on concerns. The current codebase prioritizes correctness and observability.
