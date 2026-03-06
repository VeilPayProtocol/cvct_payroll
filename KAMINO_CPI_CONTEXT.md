# Kamino Vault CPI Context (Local Testing + Adapter Notes)

This file captures the Kamino Vault CPI wiring and test insights derived from the prior `kamino_cpi_test` work.

## Program IDs
- Kamino Vault program: `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`
- Kamino Lend (klend) program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`

## PDA seeds
These are required for correct CPI account constraints.
- `BASE_VAULT_AUTHORITY_SEED = "authority"`
- `TOKEN_VAULT_SEED = "token_vault"`
- `SHARES_SEED = "shares"`
- `EVENT_AUTHORITY_SEED = "__event_authority"`
- `GLOBAL_CONFIG_STATE_SEED = "global_config"`

Derivations (all under Kamino Vault program):
- `base_vault_authority = PDA(["authority", vault_state])`
- `token_vault = PDA(["token_vault", vault_state])`
- `shares_mint = PDA(["shares", vault_state])`
- `event_authority = PDA(["__event_authority"])`
- `global_config = PDA(["global_config"])`

## VaultState size
When pre-creating the vault state account (local testing), it must be **62,552 bytes**.
- `VAULT_STATE_SIZE = 62_552`

If you allocate less, Kamino panics with out-of-range deserialization.

## init_vault prerequisites
Before calling `init_vault` (CPI), you must:
1. Create `vault_state` (owned by Kamino program, size 62,552).
2. Create and initialize `base_token_mint` (SPL mint).
3. Create and initialize `admin_token_account` (token account for base mint, owned by admin).
4. Fund `admin_token_account` with at least `1000` base units (Kamino does initial deposit).

Kamino will create `token_vault` and `shares_mint` via PDA init.

## Deposit CPI (user)
Accounts (per IDL):
- `user` (signer)
- `vault_state`
- `token_vault`
- `token_mint`
- `base_vault_authority`
- `shares_mint`
- `user_token_ata`
- `user_shares_ata`
- `klend_program`
- `token_program`
- `shares_token_program`
- `event_authority`
- `program` (Kamino Vault program id)

## Withdraw CPI (simpler path)
Use `withdraw_from_available` for v1 simplicity:
Accounts:
- `user` (signer)
- `vault_state`
- `global_config`
- `token_vault`
- `base_vault_authority`
- `user_token_ata`
- `token_mint`
- `user_shares_ata`
- `shares_mint`
- `token_program`
- `shares_token_program`
- `klend_program`
- `event_authority`
- `program` (Kamino Vault program id)

## Local test flow checklist
1. Create/initialize `base_token_mint`.
2. Create/initialize `admin_token_account`.
3. Mint base tokens to admin token account.
4. Create `vault_state` (Kamino owned, size 62,552).
5. CPI `init_vault`.
6. Create `user_shares_ata` for shares mint.
7. CPI `deposit`.
8. CPI `withdraw_from_available`.

## Gotchas encountered
- Wrong seed for base vault authority: **must be "authority"**.
- `vault_state` size mismatch causes panic.
- `admin_token_account` must be funded before `init_vault`.
- If you pass extra signers not required by the outer instruction, Anchor client rejects with `unknown signer`.

