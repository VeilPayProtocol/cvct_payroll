<<<<<<< HEAD
# Primitive Confidential Vault‑Backed Accounts (CVCT)

## Abstract

This document describes **Primitive Confidential Vault‑Backed Accounts (PCVBAs)** — a minimal, composable privacy primitive for Solana‑based systems implemented as **CVCT** in this repository. PCVBAs decouple *ownership*, *balance confidentiality*, and *execution authorization* by introducing vault‑backed accounts whose sensitive state is never revealed on‑chain in plaintext. Correctness is enforced through program constraints and cryptographic transitions.

The goal is not to build a monolithic privacy protocol, but to provide a **primitive** that other programs (payroll, DAOs, marketplaces, reputation systems) can integrate with minimal surface area and predictable security guarantees.

---

## Motivation

On‑chain programs typically expose:

* account balances,
* transfer amounts,
* participant relationships,
* and business logic flows.

This transparency is often undesirable for:

* payroll systems,
* compliance‑aware payments,
* sealed‑bid interactions,
* contributor compensation,
* or reputation‑linked incentives.

Existing privacy systems are powerful but heavy: they require custom circuits, specialized tooling, or tight coupling to a single protocol.

**PCVBAs aim to sit lower in the stack**:

* small enough to audit,
* flexible enough to compose,
* opinionated only where necessary.
=======
# CVCT Technical Overview (Arcium)

## Abstract

CVCT is a confidential accounting layer for Solana. It keeps balances, mint totals, and internal transfers private while preserving full on‑chain custody through SPL token vaults. This branch uses **Arcium** as an MPC co‑processor: encrypted values are updated off‑chain and written back on‑chain via authenticated callbacks.
>>>>>>> cvct_arcium

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

<<<<<<< HEAD
1. **Vault PDA**
   Holds real assets (SOL or SPL tokens). This account is fully on‑chain and auditable.

2. **Confidential Account State**
   Stores encrypted balances and metadata, rather than plaintext values.

3. **Program‑Enforced Transitions**
   State transitions are validated by the program using invariant checks instead of revealing values.

The key idea is that **assets are real and locked**, but **their distribution and movement are confidential**.

---

## Architecture Overview

```text
User / Program
     │
     │ intent (deposit / withdraw / transfer)
     ▼
Confidential Program
     │
     ├─ verifies authorization
     ├─ checks commitment transitions
     ├─ enforces invariants
     ▼
Vault PDA (Funds)
```

The vault never moves funds unless a valid confidential transition is proven.

---

## Account Model

### 1. Vault Account (PDA)

* Holds SOL or SPL tokens
* Owned by the confidential program
* Never stores user‑specific metadata

### 2. Confidential Account

Stores:
* encrypted balance (`Euint128` via INCO Lightning)
* nonce / version
* authority reference

Example (conceptual):

```text
ConfidentialAccount {
  authority: Pubkey,
  balance: Euint128,
  nonce: u64,
}
```
=======
### Off‑chain (Arcium MPC)
Arcis circuits define the encrypted transitions. The program queues computations and only stores the resulting ciphertexts + nonces.
>>>>>>> cvct_arcium

---

## State Transitions

### Initialize Mint
1. Create `CvctMint` and `Vault`.
1. Queue `init_mint_state` circuit.
1. Callback writes encrypted zero totals.

<<<<<<< HEAD
* User transfers assets into the vault
* Program updates encrypted balance, total supply, and total locked via CPI
* No plaintext balances are revealed on‑chain
=======
### Initialize Account
1. Create `CvctAccount`.
1. Queue `init_account_state`.
1. Callback writes encrypted zero balance.
>>>>>>> cvct_arcium

### Deposit and Mint
1. SPL transfer: user → vault.
1. Queue `deposit_and_mint`.
1. Callback writes updated encrypted balance, supply, and locked totals.

<<<<<<< HEAD
* Program validates encrypted decrement via CPI
* Assets are released from the vault
* Public observers see only the vault movement, not internal balances

### Internal Transfer

* Two confidential accounts update encrypted balances atomically
* Vault balance remains unchanged
=======
### Burn and Withdraw
1. Queue `burn_and_withdraw`.
1. Circuit checks `balance >= amount` and returns `ok`.
1. Callback writes updated encrypted state, then transfers SPL vault → user if `ok`.

### Transfer
1. Queue `transfer_cvct`.
1. Circuit updates sender/recipient encrypted balances and returns `ok`.
1. Callback writes updated encrypted balances.
>>>>>>> cvct_arcium

---

## Confidentiality Model

<<<<<<< HEAD
PCVBAs **do not rely on secrecy of code or validators**.

Confidentiality is achieved by:
* never storing balances in plaintext
* never emitting sensitive values in logs
* enforcing arithmetic via **INCO Lightning encrypted arithmetic** (`Euint128`)

INCO Lightning provides:
* `as_euint128` for encryption of plaintext inputs
* `e_add`, `e_sub`, `e_ge`, `e_select` for encrypted arithmetic and comparisons
* `allow` to grant account owners decryption access to their balances
=======
1. Ciphertexts and nonces are stored on‑chain.
1. MPC runs on secret‑shared values and returns authenticated ciphertexts.
1. No plaintext balances or transfer amounts are revealed on‑chain.
>>>>>>> cvct_arcium

---

## Security Invariants

<<<<<<< HEAD
The program enforces:

1. **Conservation of Value**
   Vault balance ≥ sum of all encrypted balances

2. **Authorized Transitions Only**
   Only the account authority can update commitments

3. **Replay Protection**
   Version / nonce increments prevent reuse

4. **Atomicity**
   Multi‑party transitions either fully succeed or fail
=======
1. **Custody is public**: vault balances are always auditable.
1. **No inflation**: total_supply is only updated through MPC transitions.
1. **Authorization**: Anchor constraints gate who can update state.
1. **Atomicity**: each transition is written in a single callback.
>>>>>>> cvct_arcium

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

<<<<<<< HEAD
* UI assumptions
* identity systems
* compliance logic
* business rules

This allows reuse in:

* payroll systems
* DAO treasuries
* reputation‑based rewards
* sealed auctions
* confidential marketplaces

---

## Example Use Cases

### Confidential Payroll

* Company deposits funds into a vault
* Employees have confidential accounts
* Salaries remain private while funds are provably locked

### Reputation‑Weighted Rewards

* Rewards distributed without revealing individual payouts
* Public can verify total emissions

### Private Task Bounties

* Contributors paid without revealing bid amounts

---

## Extensibility

Future upgrades can add:

* ZK proof verification
* encrypted memo support
* cross‑program confidential calls
* threshold or multisig authorities

All without changing the vault interface.

---

## Auditability

Although balances are confidential:
* vault balances are public
* program logic is deterministic
* invariants are verifiable

This strikes a balance between **privacy and trust minimization**.

---

## Hackathon Relevance

This project provides:
* a **foundational privacy building block**
* immediate composability with existing Solana programs
* a clear path toward stronger cryptographic privacy

Rather than another end‑user app, PCVBAs expand the design space for *all* Solana developers.

---

## Conclusion

Primitive Confidential Vault‑Backed Accounts introduce a lightweight, enforceable privacy layer for on‑chain assets. By separating custody from disclosure, they enable confidential value flows while preserving Solana’s transparency and performance characteristics.

This primitive is intended to be **built upon**, not locked into a single application — aligning with the long‑term needs of privacy‑preserving on‑chain systems.

---

**Migration note:** We are moving the confidential computation layer from **INCO Lightning** to **Arcium** to address the current `burn_and_withdraw` edge case and improve MPC‑style workflows going forward.
=======
>>>>>>> cvct_arcium
