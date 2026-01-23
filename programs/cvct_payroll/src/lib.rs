use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use arcium_anchor::prelude::*;

declare_id!("Sd92uPUtbHdnoRFmi6xCEsLVh4Yg3KYcNbGXeSJVL5R");

#[arcium_program]
pub mod cvct_payroll {
    use super::*;

    pub fn initialize_cvct_mint(ctx: Context<InitializeCvctMint>) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;

        cvct_mint.authority = ctx.accounts.authority.key();
        cvct_mint.backing_mint = ctx.accounts.backing_mint.key();
        cvct_mint.total_supply = 0;

        vault.cvct_mint = cvct_mint.key();
        vault.backing_mint = ctx.accounts.backing_mint.key();
        vault.backing_token_account = ctx.accounts.vault_token_account.key();
        vault.total_locked = 0;

        Ok(())
    }

    pub fn initialize_cvct_account(ctx: Context<InitializeCvctAccount>) -> Result<()> {
        let cvct_account = &mut ctx.accounts.cvct_account;

        cvct_account.owner = ctx.accounts.owner.key();
        cvct_account.cvct_mint = ctx.accounts.cvct_mint.key();
        cvct_account.balance = 0;

        Ok(())
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}

// ============================================
//                   CVCT
// ============================================

#[account]
#[derive(InitSpace)]
pub struct CvctMint {
    pub authority: Pubkey,
    pub backing_mint: Pubkey,
    pub total_supply: u64,
    pub decimals: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CvctAccount {
    pub owner: Pubkey,
    pub cvct_mint: Pubkey,
    pub balance: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub cvct_mint: Pubkey,
    pub backing_mint: Pubkey,
    pub backing_token_account: Pubkey,
    pub total_locked: u64,
}

#[error_code]
pub enum CvctError {
    InsufficientFunds,
    InvariantViolation,
    InvalidVault,
    Unauthorized,
}

#[derive(Accounts)]
pub struct InitializeCvctMint<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CvctMint::INIT_SPACE,
        seeds = [b"cvct_mint", authority.key().as_ref()],
        bump,
    )]
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    pub backing_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = backing_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct InitializeCvctAccount<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + CvctAccount::INIT_SPACE,
        seeds = [b"cvct_account", cvct_mint.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub cvct_account: Account<'info, CvctAccount>,
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================
//                   Payroll
// ============================================

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub cvct_mint: Pubkey,
    pub treasury_vault: Pubkey,
    pub fee_bps: u16,
}
