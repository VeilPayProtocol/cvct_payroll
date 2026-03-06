# Deposit And Mint Defenses

This document explains the inflation-attack defenses used in `deposit_and_mint`.

## Problem

If share minting uses only `shares = floor(amount * supply / assets)`, a near-empty
vault can be manipulated by donation-style attacks that worsen rounding for the next
depositor.

## Defense Used

The confidential circuit uses virtual offsets in the exchange-rate formula:

`shares = floor(amount * (supply + VS) / (assets + VA))`

Where:

- `VS` = `VIRTUAL_SHARE_OFFSET`
- `VA` = `VIRTUAL_ASSET_OFFSET`

Current values:

- `VA = 1`
- `VS = 1`

These offsets:

1. Keep the formula well-defined at empty state (`supply = 0`, `assets = 0`).
2. Reduce sensitivity to donation-based rate manipulation.
3. Preserve bootstrap behavior (`amount` deposits mint `amount` shares at init).

## Additional Guards

The circuit rejects minting (`ok = false`) when:

1. State is corrupted (`supply > 0` and `assets == 0`).
2. Rounding would mint zero shares (`shares == 0`).

## Callback Refund Behavior

The instruction transfers tokens into vault first, then waits for Arcium callback.
If the circuit returns `ok = false`, callback refunds the full deposit amount from
vault token account back to user token account.

This prevents silent donation/loss when a deposit is economically invalid.

## Code Locations

- Circuit math: `/Users/fido/Projects/cvct_payroll/encrypted-ixs/src/lib.rs`
- Queue + callback refund: `/Users/fido/Projects/cvct_payroll/programs/cvct/src/lib.rs`
