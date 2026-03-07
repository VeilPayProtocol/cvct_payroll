# Kamino Adapter

## Scope

CVCT integrates Kamino as a manual treasury adapter, not as part of the user hot path.

That means:
- deposit and redeem do not CPI into Kamino
- treasury movement is explicit and authority-driven
- low-liquidity redeem retry is operationally simple

## Why this design was chosen

Putting Kamino inside `settle_deposit_commit` or `settle_redeem_commit` would make the user-critical path:
- larger
- more compute-sensitive
- harder to retry safely
- harder to reason about under callback timing or CPI failure

The current design keeps the accounting path and treasury path separate.

## Adapter state

`KaminoAdapterState` stores the Kamino vault wiring needed for a single `CvctMint`.

It includes:
- `vault_state`
- `global_config`
- `base_vault_authority`
- `token_vault`
- `shares_mint`
- `event_authority`
- `klend_program`
- `enabled`

The adapter is Kamino-specific and uses the pinned Kamino Vault program identity in code.

## Adapter instructions

### `configure_kamino_adapter`
Initializes or updates the adapter state for a mint.

### `kamino_deposit_idle`
Moves idle backing assets from the CVCT vault token account into Kamino.

### `kamino_withdraw_to_vault`
Withdraws assets back from Kamino so the vault can satisfy payouts.

### `sync_total_assets_from_adapter`
Updates encrypted `total_locked` after treasury movement or valuation change.

## Redeem under low idle liquidity

This is the intended operational flow:

1. User requests redeem
2. Callback stages redeem success
3. `settle_redeem_commit` fails with `InsufficientIdleLiquidity`
4. Treasury withdraws liquidity from Kamino
5. `settle_redeem_commit` is retried
6. Canonical confidential burn state commits only on the successful retry

This is one of the main benefits of staged redeem settlement.

## Local testing model

The local integration suite preloads:
- Kamino Vault program binary
- KLend program binary
- Kamino `global_config` account

Anchor localnet configuration lives in:
- [`Anchor.toml`](../Anchor.toml)

Local Kamino fixture assets live in:
- `tests/fixtures/kamino/`

## What is intentionally not implemented

- automatic deploy of new deposits into Kamino
- automatic withdraw during redeem settlement
- Token-2022 shares support for the Kamino adapter path

Those are future design choices. The current adapter is deliberately conservative.
