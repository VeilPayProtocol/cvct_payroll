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
}
