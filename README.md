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
