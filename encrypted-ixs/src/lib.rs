use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // Inflation-attack hardening constants for share minting.
    // We use virtual offsets even when the vault is empty so the exchange-rate
    // calculation is always well-defined and less sensitive to donation-based
    // manipulation.
    const VIRTUAL_ASSET_OFFSET: u128 = 1;
    const VIRTUAL_SHARE_OFFSET: u128 = 1;
    // Keep operands under a strict bound so multiplication in quote-verification
    // inequalities stays within u128.
    const MAX_SAFE_OPERAND: u128 = (u64::MAX as u128) - 1;

    #[instruction]
    pub fn init_mint_state(
        authority: Shared,
        vault: Shared,
    ) -> (Enc<Shared, u128>, Enc<Shared, u128>) {
        // This circuit initializes encrypted zero values for mint totals.
        // The `Shared` inputs represent public-key + nonce pairs supplied by the client.
        // Each `from_arcis(0)` produces an encrypted u128 under that input's key.
        (
            authority.from_arcis(0u128),
            vault.from_arcis(0u128),
        )
    }

    #[instruction]
    pub fn init_account_state(owner: Shared) -> Enc<Shared, u128> {
        // Initializes an encrypted zero balance for a CVCT account.
        // The `owner` input is the account owner's encryption context.
        owner.from_arcis(0u128)
    }

    #[instruction]
    pub fn deposit_and_mint(
        balance: Enc<Shared, u128>,
        amount: u128,
        quoted_shares: u128,
        owner_out: Shared,
        total_supply: Enc<Shared, u128>,
        mint_out: Shared,
        total_locked: Enc<Shared, u128>,
        vault_out: Shared,
    ) -> (
        Enc<Shared, u128>,
        Enc<Shared, u128>,
        Enc<Shared, u128>,
        bool,
        u128,
    ) {
        // Share economics with virtual offsets (YieldBox-style defense):
        // shares = floor(amount * (supply + VS) / (assets + VA)).
        //
        // To keep Arcium CU low, we avoid division in-circuit and instead verify
        // that a caller-provided quote equals the floor division result:
        // q*(assets+VA) <= amount*(supply+VS) < (q+1)*(assets+VA)
        let bal = balance.to_arcis();
        let supply = total_supply.to_arcis();
        let locked = total_locked.to_arcis();

        // Keep a strict guard for corrupted states.
        let safe_operands = supply <= MAX_SAFE_OPERAND
            && locked <= MAX_SAFE_OPERAND
            && amount <= MAX_SAFE_OPERAND
            && quoted_shares <= MAX_SAFE_OPERAND;
        let ratio_valid = supply == 0 || locked > 0;
        let lhs = quoted_shares * (locked + VIRTUAL_ASSET_OFFSET);
        let rhs = amount * (supply + VIRTUAL_SHARE_OFFSET);
        let upper = (quoted_shares + 1) * (locked + VIRTUAL_ASSET_OFFSET);
        let quote_valid = lhs <= rhs && upper > rhs;
        let ok = safe_operands && ratio_valid && quoted_shares > 0 && quote_valid;

        let new_balance = if ok { bal + quoted_shares } else { bal };
        let new_total_supply = if ok { supply + quoted_shares } else { supply };
        let new_total_locked = if ok { locked + amount } else { locked };

        (
            owner_out.from_arcis(new_balance),
            mint_out.from_arcis(new_total_supply),
            vault_out.from_arcis(new_total_locked),
            ok.reveal(),
            quoted_shares.reveal(),
        )
    }

    #[instruction]
    pub fn burn_and_withdraw(
        balance: Enc<Shared, u128>,
        amount: u128,
        quoted_assets: u128,
        owner_out: Shared,
        total_supply: Enc<Shared, u128>,
        mint_out: Shared,
        total_locked: Enc<Shared, u128>,
        vault_out: Shared,
    ) -> (
        Enc<Shared, u128>,
        Enc<Shared, u128>,
        Enc<Shared, u128>,
        bool,
        u128,
    ) {
        let bal = balance.to_arcis();
        let supply = total_supply.to_arcis();
        let locked = total_locked.to_arcis();
        let shares = amount;

        // Share redemption math mirrors deposit pricing with virtual offsets:
        // assets = floor(shares * (assets + VA) / (supply + VS)).
        //
        // We verify a caller quote instead of dividing in-circuit:
        // q*(supply+VS) <= shares*(assets+VA) < (q+1)*(supply+VS)
        let safe_operands = supply <= MAX_SAFE_OPERAND
            && locked <= MAX_SAFE_OPERAND
            && shares <= MAX_SAFE_OPERAND
            && quoted_assets <= MAX_SAFE_OPERAND;
        let ratio_valid = supply > 0 && locked > 0;
        let lhs = quoted_assets * (supply + VIRTUAL_SHARE_OFFSET);
        let rhs = shares * (locked + VIRTUAL_ASSET_OFFSET);
        let upper = (quoted_assets + 1) * (supply + VIRTUAL_SHARE_OFFSET);
        let quote_valid = lhs <= rhs && upper > rhs;
        let ok = safe_operands
            && ratio_valid
            && bal >= shares
            && supply >= shares
            && quoted_assets > 0
            && locked >= quoted_assets
            && quote_valid;

        // Both branches execute in MPC, so compute and select.
        let new_balance = if ok { bal - shares } else { bal };
        let new_supply = if ok { supply - shares } else { supply };
        let new_locked = if ok { locked - quoted_assets } else { locked };

        (
            owner_out.from_arcis(new_balance),
            mint_out.from_arcis(new_supply),
            vault_out.from_arcis(new_locked),
            ok.reveal(),
            quoted_assets.reveal(),
        )
    }

    #[instruction]
    pub fn transfer_cvct(
        from_balance: Enc<Shared, u128>,
        amount: u128,
        from_out: Shared,
        to_balance: Enc<Shared, u128>,
        to_out: Shared,
    ) -> (Enc<Shared, u128>, Enc<Shared, u128>, bool) {
        let from = from_balance.to_arcis();
        let to = to_balance.to_arcis();
        let ok = from >= amount;

        let new_from = if ok { from - amount } else { from };
        let new_to = if ok { to + amount } else { to };

        (
            from_out.from_arcis(new_from),
            to_out.from_arcis(new_to),
            ok.reveal(),
        )
    }
}
