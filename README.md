<<<<<<< HEAD
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
=======
# CVCT (Arcium) — Confidential Vault‑Backed Tokens

CVCT is a privacy‑preserving token layer for Solana that keeps balances and payroll flows confidential while remaining fully backed by on‑chain SPL assets. This branch uses **Arcium** as the confidential co‑processor: all sensitive state transitions happen inside MPC, while custody remains on Solana.

## Hackathon Summary

Solana is transparent by default. CVCT makes payroll, treasury ops, and confidential DeFi flows possible by separating:
1. **Custody** — public vaults hold real SPL assets.
1. **Accounting** — encrypted balances and totals are updated via MPC.
1. **Authorization** — Anchor constraints enforce who can trigger updates.

CVCT is a **primitive** that other programs can build on, not a single closed system.

## Core Components

**On‑chain accounts**
1. `CvctMint`: metadata for a confidential mint, backed 1:1 by an SPL mint.
1. `Vault`: PDA that holds the backing SPL tokens.
1. `CvctAccount`: per‑user confidential balance account.

**Confidential circuits (Arcis)**
1. `init_mint_state` — encrypts zeros for total supply and total locked.
1. `init_account_state` — encrypts zero balance for a new account.
1. `deposit_and_mint` — adds amount to encrypted balance/supply/locked.
1. `burn_and_withdraw` — subtracts amount if balance permits and returns a boolean.
1. `transfer_cvct` — transfers between encrypted balances.

**Arcium flow**
1. Instruction queues computation via `queue_computation`.
1. MPC executes the Arcis circuit.
1. Callback writes ciphertexts + nonces back on‑chain.

## Repo Layout

1. `programs/cvct`: Anchor program that queues computations and writes callbacks.
1. `encrypted-ixs`: Arcis circuits for encrypted state transitions.
1. `tests`: End‑to‑end tests that decrypt balances client‑side to verify correctness.

## Why Arcium Improves Privacy

Arcium provides:
1. **Confidential computation** over encrypted values.
1. **Verified outputs** via callback signature checks.
1. **Minimal on‑chain leakage** (ciphertexts + nonces only).

This removes the need for custom cryptography in the program while keeping custody on Solana.

## Running Locally

1. Build: `arcium build`
1. Test: `arcium test`

## Note

This branch is the forward path of CVCT. It replaces earlier INCO‑based encrypted arithmetic with Arcium MPC to improve correctness and privacy guarantees for withdrawals and transfers.
>>>>>>> cvct_arcium
