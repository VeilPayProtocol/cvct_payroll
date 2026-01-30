# Primitive Confidential Vault‑Backed Accounts

## Abstract

This document describes **Primitive Confidential Vault‑Backed Accounts (PCVBAs)** — a minimal, composable privacy primitive for Solana‑based systems. PCVBAs decouple *ownership*, *balance confidentiality*, and *execution authorization* by introducing vault‑backed accounts whose sensitive state is never revealed on‑chain in plaintext. Instead, correctness is enforced through constrained program logic, commitments, and verifiable transitions.

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

---

## Design Goals

1. **Minimalism** — keep the on‑chain surface small and auditable.
2. **Composability** — usable as a building block by unrelated programs.
3. **Confidential State** — balances and internal accounting are not publicly readable.
4. **Deterministic Enforcement** — no trust in off‑chain actors for correctness.
5. **Upgradeable Privacy** — support stronger cryptography without redesigning interfaces.

---

## Core Concept

A **Confidential Vault‑Backed Account** is composed of:

1. **Vault PDA**
   Holds real assets (SOL or SPL tokens). This account is fully on‑chain and auditable.

2. **Confidential Account State**
   Stores *commitments* to balances and metadata, rather than plaintext values.

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

* balance commitment (e.g. hash or encrypted value)
* nonce / version
* authority reference

Example (conceptual):

```text
ConfidentialAccount {
  authority: Pubkey,
  balance_commitment: [u8; 32],
  version: u64,
}
```

---

## State Transitions

### Deposit

* User transfers assets into the vault
* Program updates balance commitment
* No plaintext amount is revealed on‑chain

### Withdrawal

* Program validates commitment decrement
* Assets are released from the vault
* Public observers see only the vault movement, not internal balances

### Internal Transfer

* Two confidential accounts update commitments atomically
* Vault balance remains unchanged

---

## Confidentiality Model

PCVBAs **do not rely on secrecy of code or validators**.

Confidentiality is achieved by:

* never storing balances in plaintext
* never emitting sensitive values in logs
* enforcing arithmetic through commitment equality

The exact cryptographic primitive is abstracted and may be:

* hash‑based commitments
* encrypted balances
* zero‑knowledge proofs (future extension)

---

## Security Invariants

The program enforces:

1. **Conservation of Value**
   Vault balance ≥ sum of all committed balances

2. **Authorized Transitions Only**
   Only the account authority can update commitments

3. **Replay Protection**
   Version / nonce increments prevent reuse

4. **Atomicity**
   Multi‑party transitions either fully succeed or fail

---

## Threat Model

### Out of Scope

* Validator collusion
* Chain‑level censorship
* Side‑channel attacks outside Solana

### In Scope

* Malicious users
* Invalid state transitions
* Unauthorized withdrawals
* Balance inflation attempts

---

## Why This Is a Primitive (Not a Product)

PCVBAs intentionally avoid:

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
