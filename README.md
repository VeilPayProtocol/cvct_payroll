# CVCT Payroll — Confidential Vault‑Backed Tokens

CVCT is a privacy‑preserving token layer for Solana that keeps balances and payroll flows confidential while staying fully backed by on‑chain SPL assets. The current main‑branch implementation uses **INCO Lightning** to store and update encrypted values on chain through CPI. This gives us verifiable, auditable custody (the vault) with private accounting (encrypted balances).

This repo demonstrates:
1. A **confidential mint** for each backing SPL token.
1. **Vault‑backed** deposits and withdrawals.
1. **Private transfers** between CVCT accounts.
1. A **payroll module** built on top of the confidential balance layer.

## Why This Matters (Hackathon Summary)

Solana’s transparency is powerful but problematic for payroll, treasury ops, and competitive business workflows. CVCT makes those use cases viable by separating:
1. **Custody** (public, auditable vaults of SPL tokens).
1. **Accounting** (encrypted balances and state transitions).
1. **Authorization** (standard Anchor constraints + INCO encryption permissions).

This creates a minimal privacy primitive that can plug into DAOs, payroll systems, or other DeFi flows without redesigning the base assets.

## Architecture Overview

**On‑chain accounts**
1. `CvctMint`: metadata for a confidential mint, backed 1:1 by an SPL mint.
1. `Vault`: PDA that holds the backing SPL tokens.
1. `CvctAccount`: per‑user confidential balance account.

**State transitions**
1. `initialize_cvct_mint`: creates the mint and vault, initializes encrypted totals.
1. `initialize_cvct_account`: creates a user account with encrypted zero balance.
1. `deposit_and_mint`: transfer SPL into vault, then add encrypted balance/supply/locked.
1. `burn_and_withdraw`: subtract encrypted balances, then release SPL from vault.
1. `transfer_cvct`: encrypted balance transfer between users.

**Privacy layer (INCO Lightning)**
1. Encrypted values are stored as `Euint128`.
1. Arithmetic is done through CPI calls such as `e_add`, `e_sub`, and `e_ge`.
1. `allow` grants the account owner access to decrypt their own balance.

## Repo Layout

1. `programs/cvct_payroll`: Anchor program with CVCT + payroll instructions.
1. `tests/cvct_payroll.ts`: integration tests for the confidential flow.
1. `runbooks/`: deployment and ops workflows.

## Running Locally

1. Build: `anchor build`
1. Test: `anchor test`

This repo assumes INCO Lightning is available on your localnet or configured cluster.

## Note on Migration

We are actively migrating the confidential computation layer from **INCO Lightning** to **Arcium**. The main motivation is to fix the current `burn_and_withdraw` edge case in the INCO version and to support a clearer MPC‑style flow going forward.
