# CVCT Technical Overview (Arcium)

## Abstract

CVCT is a confidential accounting layer for Solana. It keeps balances, mint totals, and internal transfers private while preserving full on‑chain custody through SPL token vaults. This branch uses **Arcium** as an MPC co‑processor: encrypted values are updated off‑chain and written back on‑chain via authenticated callbacks.

---

## Design Goals

1. **Confidentiality** — balances and internal flows are not revealed on‑chain.
1. **Auditability** — custody is public and verifiable via vault balances.
1. **Composability** — designed as a primitive for payroll, DAOs, and DeFi.
1. **Minimal Surface** — keep on‑chain logic small, deterministic, and auditable.

---

## Architecture

### On‑chain
1. **Vault PDA**: holds backing SPL tokens.
1. **CvctMint**: metadata + encrypted `total_supply`.
1. **CvctAccount**: per‑user encrypted `balance`.

### Off‑chain (Arcium MPC)
Arcis circuits define the encrypted transitions. The program queues computations and only stores the resulting ciphertexts + nonces.

---

## State Transitions

### Initialize Mint
1. Create `CvctMint` and `Vault`.
1. Queue `init_mint_state` circuit.
1. Callback writes encrypted zero totals.

### Initialize Account
1. Create `CvctAccount`.
1. Queue `init_account_state`.
1. Callback writes encrypted zero balance.

### Deposit and Mint
1. SPL transfer: user → vault.
1. Queue `deposit_and_mint`.
1. Callback writes updated encrypted balance, supply, and locked totals.

### Burn and Withdraw
1. Queue `burn_and_withdraw`.
1. Circuit checks `balance >= amount` and returns `ok`.
1. Callback writes updated encrypted state, then transfers SPL vault → user if `ok`.

### Transfer
1. Queue `transfer_cvct`.
1. Circuit updates sender/recipient encrypted balances and returns `ok`.
1. Callback writes updated encrypted balances.

---

## Confidentiality Model

1. Ciphertexts and nonces are stored on‑chain.
1. MPC runs on secret‑shared values and returns authenticated ciphertexts.
1. No plaintext balances or transfer amounts are revealed on‑chain.

---

## Security Invariants

1. **Custody is public**: vault balances are always auditable.
1. **No inflation**: total_supply is only updated through MPC transitions.
1. **Authorization**: Anchor constraints gate who can update state.
1. **Atomicity**: each transition is written in a single callback.

---

## Why MPC (Arcium)

Arcium removes the need to embed cryptographic arithmetic directly on‑chain while preserving:
1. Deterministic verification of outputs.
1. Confidential state updates.
1. A clean interface for future ZK or multi‑party extensions.

---

## Tests

The test suite:
1. Initializes mint + accounts.
1. Deposits and mints.
1. Burns and withdraws.
1. Transfers between accounts.
1. Decrypts ciphertexts client‑side to verify correctness in cleartext.

