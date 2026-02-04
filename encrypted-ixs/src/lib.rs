use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

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
        owner_out: Shared,
        total_supply: Enc<Shared, u128>,
        mint_out: Shared,
        total_locked: Enc<Shared, u128>,
        vault_out: Shared,
    ) -> (Enc<Shared, u128>, Enc<Shared, u128>, Enc<Shared, u128>) {
        // Add plaintext deposit amount to encrypted balance, supply, and locked totals.
        let new_balance = balance.to_arcis() + amount;
        let new_total_supply = total_supply.to_arcis() + amount;
        let new_total_locked = total_locked.to_arcis() + amount;

        (
            owner_out.from_arcis(new_balance),
            mint_out.from_arcis(new_total_supply),
            vault_out.from_arcis(new_total_locked),
        )
    }

    #[instruction]
    pub fn burn_and_withdraw(
        balance: Enc<Shared, u128>,
        amount: u128,
        owner_out: Shared,
        total_supply: Enc<Shared, u128>,
        mint_out: Shared,
        total_locked: Enc<Shared, u128>,
        vault_out: Shared,
    ) -> (Enc<Shared, u128>, Enc<Shared, u128>, Enc<Shared, u128>, bool, u128) {
        let bal = balance.to_arcis();
        let ok = bal >= amount;

        // Both branches execute in MPC, so compute and select.
        let new_balance = if ok { bal - amount } else { bal };
        let supply = total_supply.to_arcis();
        let new_supply = if ok { supply - amount } else { supply };
        let locked = total_locked.to_arcis();
        let new_locked = if ok { locked - amount } else { locked };

        (
            owner_out.from_arcis(new_balance),
            mint_out.from_arcis(new_supply),
            vault_out.from_arcis(new_locked),
            ok.reveal(),
            amount,
        )
    }
}
