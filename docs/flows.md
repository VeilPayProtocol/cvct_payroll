# Flows

## Initialization

### One-time Arcium setup
The program initializes computation definitions for:
- mint state init
- account state init
- deposit and mint
- burn and withdraw
- transfer

### Mint initialization
`initialize_cvct_mint` creates:
- `CvctMint`
- `Vault`
- `PricingState`

Then callbacks initialize encrypted zero state for mint supply and locked assets.

### Account initialization
`initialize_cvct_account` creates a per-user `CvctAccount` and initializes encrypted zero balance state.

## Deposit flow

### Request
`request_deposit_intent`

Creates:
- `PendingOperation`
- `PendingDepositResult`

Stores:
- `assets_in`
- `min_shares_out`
- `quoted_shares_out`
- `deadline_slot`
- pricing and balance version snapshots

No custody movement happens here.

### Callback
`deposit_and_mint_callback`

Writes:
- staged encrypted user balance
- staged encrypted total supply
- staged encrypted total locked
- `shares_out`
- `ok`

If the pricing or user balance version changed underneath the request, the operation is invalidated instead of becoming settleable.

### Settle
`settle_deposit_commit`

Success path:
1. validate staged result
2. transfer backing assets from user token account into vault token account
3. if the Kamino adapter is enabled, compute idle excess against the configured threshold
4. if excess exists, deposit only that excess into Kamino
5. commit staged encrypted state into canonical accounts
6. increment `pricing_version`
7. increment user `balance_version`
8. mark operation `Settled`

Failure path:
- if callback computed `ok = false`, mark operation `Failed`
- no custody movement

Adapter-required failure path:
- if the adapter is enabled and Kamino deposit accounts are missing, miswired, or the CPI fails, the entire transaction reverts
- user custody and canonical confidential state both remain unchanged

### Cancel and expire
Deposits also support:
- `cancel_deposit_intent`
- `expire_deposit_intent`

These apply only to unresolved request-phase deposits.

## Redeem flow

### Request
`request_redeem_intent`

Creates:
- `PendingOperation`
- `PendingRedeemResult`

Stores:
- `shares_in`
- `quoted_assets_out`
- pricing and balance version snapshots

No asset payout happens here.

### Callback
`burn_and_withdraw_callback`

Writes a staged redeem result only.

If the pricing or user balance version changed underneath the request, the operation invalidates.

### Settle
`settle_redeem_commit`

Success path:
1. validate staged result
2. if idle liquidity is short and the Kamino adapter is enabled, withdraw `deficit + redeem buffer` from Kamino
3. transfer backing assets from vault token account to user token account
4. commit staged confidential burn state into canonical accounts
5. increment `pricing_version`
6. increment user `balance_version`
7. mark operation `Settled`

Low-liquidity path:
- if Kamino is disabled or cannot supply enough liquidity, return `InsufficientIdleLiquidity`
- leave the operation in `ComputedSuccess`
- do not mutate canonical state

Computed failure path:
- mark operation `Failed`
- no payout

## Transfer flow

### Request
`transfer_cvct`

Creates `PendingTransferResult` and snapshots:
- sender balance version
- recipient balance version

### Callback
`transfer_cvct_callback`

If sender or recipient version changed:
- mark transfer result as callback-applied with `ok = false`
- do not mutate canonical balances

If computation result itself is `ok = false`:
- store the failed transfer result
- do not mutate canonical balances
- do not bump versions

If successful:
- commit sender and recipient balances
- increment both account balance versions

## Sync flow

### `sync_total_assets`
Authority-updated synchronization for encrypted vault assets.

Behavior:
- identical ciphertext + nonce: no-op, no pricing version bump
- changed ciphertext or nonce: write new state and increment `pricing_version`

### `sync_total_assets_from_adapter`
Same rule, but used when the source of truth includes treasury adapter movements.

## Kamino treasury flow

### Configure
`configure_kamino_adapter`

Stores the Kamino vault wiring for a mint.

### Deploy idle assets
`kamino_deposit_idle`

Moves idle backing assets from the CVCT vault token account into Kamino.

### Pull liquidity back
`kamino_withdraw_to_vault`

Returns liquidity from Kamino back to the CVCT vault token account.

### Why this is separate
Kamino is kept out of deposit and redeem hot paths so user-facing settlement remains small, deterministic, and retry-safe.

## Cleanup flow

### Deposit cleanup
`cleanup_terminal_deposit`

Closes:
- `PendingOperation`
- `PendingDepositResult`

Allowed only when the deposit operation is terminal.

### Redeem cleanup
`cleanup_terminal_redeem`

Closes:
- `PendingOperation`
- `PendingRedeemResult`

Allowed only when the redeem operation is terminal.

### Transfer cleanup
`cleanup_transfer_result`

Closes:
- `PendingTransferResult`

Allowed only after callback has been applied.

## Failure model summary

### Deposit
- invalid quote -> `Failed`
- stale pricing state -> `Invalidated`
- stale user balance state -> `Invalidated`

### Redeem
- invalid quote or insufficient balance -> `Failed`
- stale pricing state -> `Invalidated`
- stale user balance state -> `Invalidated`
- insufficient idle liquidity -> retryable `ComputedSuccess`

### Transfer
- insufficient sender balance -> failed result, no canonical mutation
- stale sender/recipient versions -> failed result, no canonical mutation
