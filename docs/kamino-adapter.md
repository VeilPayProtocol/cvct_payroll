# Kamino Adapter

## Scope

CVCT integrates Kamino as a treasury adapter with asymmetric user-path behavior.

That means:
- deposit settlement can deploy excess idle liquidity into Kamino inline
- redeem settlement can pull liquidity from Kamino inline when idle vault liquidity is short
- explicit treasury instructions still exist as operator escape hatches

## Why this design was chosen

The program now treats the two sides differently:
- `settle_deposit_commit` owns deploy-side rebalance because fresh idle liquidity appears there
- `settle_redeem_commit` owns low-liquidity recovery because that is the redeem hot path
- explicit treasury instructions remain available for recovery, testing, and operations

This keeps the protocol onchain-first without pretending Solana programs can schedule themselves later.

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
- `idle_liquidity_threshold_bps`
- `redeem_withdraw_buffer_amount`

The adapter is Kamino-specific and uses the pinned Kamino Vault program identity in code.

## Adapter instructions

### `configure_kamino_adapter`
Initializes or updates the adapter state for a mint.

On first configuration, the adapter defaults to:
- `idle_liquidity_threshold_bps = 10_000`
- `redeem_withdraw_buffer_amount = 0`

That preserves the pre-policy behavior of keeping all liquidity idle until treasury policy is explicitly tightened.

### `update_kamino_policy`
Updates:
- `idle_liquidity_threshold_bps`
- `redeem_withdraw_buffer_amount`

The threshold controls how much liquidity stays idle in the CVCT vault.

### `kamino_deposit_idle`
Moves idle backing assets from the CVCT vault token account into Kamino.

### `kamino_withdraw_to_vault`
Withdraws assets back from Kamino so the vault can satisfy payouts.

### `sync_total_assets_from_adapter`
Updates encrypted `total_locked` after treasury movement or valuation change.

## Deposit-side deployment

When the adapter is enabled, `settle_deposit_commit` becomes the deploy-side rebalance owner.

The success path is:

1. validate the staged deposit result
2. transfer backing assets from the user into the CVCT vault
3. read idle vault liquidity and the CVCT-owned liquid Kamino position
4. compute `target_idle` from `idle_liquidity_threshold_bps`
5. if `idle > target_idle`, deposit only the excess into Kamino
6. commit canonical confidential state only after the Kamino CPI succeeds

If the adapter is enabled and the required Kamino accounts are missing or miswired, deposit settlement fails and the whole transaction reverts.

## Redeem under low idle liquidity

`settle_redeem_commit` now handles low-idle liquidity directly.

1. User requests redeem
2. Callback stages redeem success
3. `settle_redeem_commit` computes the vault deficit
4. if Kamino is enabled, it withdraws `deficit + redeem_withdraw_buffer_amount`, capped by liquid Kamino availability
5. the user payout settles
6. canonical confidential burn state commits in the same instruction flow

If the Kamino pull cannot satisfy the payout, the instruction fails and canonical state is unchanged.

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

- background or scheduled treasury automation without a user or operator instruction
- automatic redeploy immediately after redeem settlement
- Token-2022 shares support for the Kamino adapter path

Those are future design choices. The current adapter is still conservative, but it now makes deposit deployment and redeem recovery happen onchain inside the settlement paths that already own those liquidity transitions.
