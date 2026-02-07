# CVCT Privacy Linkages & Upgrade TODOs

This document captures the **current linkage points** in CVCT and the **concrete upgrade paths** to improve privacy. It’s a working roadmap we can pick up later.

---

## 1. Linkage Point: Deposits (SPL → Vault)

### What leaks today
1. Depositor wallet address (source of SPL transfer).
2. Amount of deposit (SPL transfer amount).
3. Which CVCT mint is being used (vault PDA).

### Upgrade ideas

**A. Shielded Deposit Pool (preferred, non‑custodial)**
1. Introduce a `DepositPool` PDA separate from the vault.
2. Users deposit SPL → `DepositPool` (unlinkable to CVCT account).
3. MPC issues CVCT to the user later (via a claim or note).
4. Vault receives SPL from the pool after MPC confirms crediting.

Pros:
1. Breaks wallet→vault linkage.
2. Can be merged with shielded withdrawal pool later.

Cons:
1. Requires extra state (notes/claims).
2. More complex lifecycle for minting.

**B. Relayer / Mixer Deposit (fast MVP)**
1. User sends SPL to a relayer or mix pool.
2. Relayer deposits into vault.
3. MPC credits user’s CVCT balance.

Pros:
1. Fastest to ship.
2. Reduces direct wallet linkage.

Cons:
1. Trust assumption on relayer.
2. Weakens censorship resistance.

**C. Stealth Deposit Address**
1. User generates a stealth SPL address.
2. Deposits from stealth address into vault.

Pros:
1. Wallet linkage reduced.

Cons:
1. Amount still visible.
2. Requires wallet support for stealth funding.

---

## 2. Linkage Point: Withdrawals (Vault → User)

### What leaks today
1. User wallet address (destination SPL address).
2. Amount withdrawn.
3. Timestamp correlation with payroll events.

### Upgrade ideas

**A. Shielded Withdrawal Pool (preferred)**
1. Replace `burn_and_withdraw` with `burn_and_shield`.
2. Vault transfers SPL → `ShieldedPool` PDA.
3. User later calls `withdraw_from_pool` with proof (or MPC ticket).

Pros:
1. Breaks link between CVCT account and withdrawal address.
2. Keeps vault accounting correct.

Cons:
1. Requires note/claim system + nullifiers.
2. Adds second step in UX.

**B. Stealth Withdrawal Address**
1. User supplies a one‑time stealth SPL address for withdrawal.
2. Vault transfers SPL → stealth address.

Pros:
1. Easy to integrate.

Cons:
1. Amount still visible.
2. Weaker unlinkability (timing correlation possible).

---

## 3. Linkage Point: CVCT Account ↔ Wallet

### What leaks today
1. CVCT account PDAs are derived from wallet pubkey.
2. Observers can link balances (ciphertexts) to wallet identities.

### Upgrade ideas

**A. Stealth CVCT Accounts (preferred)**
1. Replace PDA seeds:
   - From: `[cvct_account, mint, wallet_pubkey]`
   - To: `[cvct_account, mint, stealth_pubkey]`
2. Add scanning support so users can discover accounts.
3. Use ephemeral scan tags or events to help detection.

Pros:
1. Breaks account↔wallet linkage.
2. Compatible with MPC design.

Cons:
1. Requires client scanning.
2. Adds key management complexity.

---

## 4. Timing Correlation (Payroll + Transfers)

### What leaks today
1. Repeated payroll timing can be linked to employers.
2. Fixed schedule reveals patterns.

### Upgrade ideas

**A. Off‑chain batching (recommended)**
1. Use a bot to bundle multiple payroll transfers.
2. Randomize ordering and timing.

**B. Randomized release windows**
1. MPC can delay or randomize withdrawal timing.

---

## Suggested Roadmap (Privacy Upgrades)

### Phase 1 — Low‑Lift Improvements
1. Add **Stealth CVCT accounts**.
2. Add **off‑chain batching** for payroll.

### Phase 2 — Shielded Cash‑out
1. Add **ShieldedPool PDA**.
2. Implement `burn_and_shield`.
3. Implement `withdraw_from_pool` with nullifiers.

### Phase 3 — Shielded Deposits
1. Add **DepositPool** + claim system.
2. Finalize full “shielded in / shielded out”.

