use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use arcium_anchor::prelude::*;

declare_id!("Sd92uPUtbHdnoRFmi6xCEsLVh4Yg3KYcNbGXeSJVL5R");

#[arcium_program]
pub mod cvct_payroll {
    use super::*;

    // ============================================
    //                   CVCT IX
    // ============================================

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

    pub fn deposit_and_mint(ctx: Context<DepositAndMint>, amount: u64) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;
        let cvct_account = &mut ctx.accounts.cvct_account;

        // 1. Transfer backing asset from user to vault
        transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Mint CVCT (update balances)
        cvct_account.balance += amount;
        cvct_mint.total_supply += amount;
        vault.total_locked += amount;

        // 3. Enforce invariant
        require!(
            cvct_mint.total_supply == vault.total_locked,
            CvctError::InvariantViolation
        );

        Ok(())
    }

    pub fn burn_and_withdraw(ctx: Context<BurnAndWithdraw>, amount: u64) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;
        let cvct_account = &mut ctx.accounts.cvct_account;

        require!(cvct_account.balance >= amount, CvctError::InsufficientFunds);

        // 1. Burn CVCT (update balances)
        cvct_account.balance -= amount;
        cvct_mint.total_supply -= amount;
        vault.total_locked -= amount;

        // 2. Transfer backing asset from vault to user
        let authority_key = cvct_mint.authority;
        let vault_seeds = &[
            b"vault".as_ref(),
            authority_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        // 3. Enforce invariant
        require!(
            cvct_mint.total_supply == vault.total_locked,
            CvctError::InvariantViolation
        );

        Ok(())
    }

    pub fn transfer_cvct(ctx: Context<TransferCvct>, amount: u64) -> Result<()> {
        let from_cvct_account = &mut ctx.accounts.from_cvct_account;
        let to_cvct_account = &mut ctx.accounts.to_cvct_account;

        // 1. Check amount > 0
        require!(amount > 0, CvctError::ZeroAmount);

        // 2. Check balance
        require!(
            from_cvct_account.balance >= amount,
            CvctError::InsufficientFunds
        );

        // 3. Debit sender
        from_cvct_account.balance -= amount;

        // 4. Credit receiver
        to_cvct_account.balance += amount;

        // No invariant change - total_supply unchanged, vault untouched

        Ok(())
    }

    // ============================================
    //                   Payroll IX
    // ============================================

    pub fn init_org(ctx: Context<InitOrg>) -> Result<()> {
        let org = &mut ctx.accounts.org;

        org.set_inner(Organization {
            authority: ctx.accounts.authority.key(),
            cvct_mint: ctx.accounts.cvct_mint.key(),
            cvct_treasury_vault: ctx.accounts.treasury_vault.key(),
        });

        Ok(())
    }

    pub fn init_org_treasury(ctx: Context<InitOrgTreasury>) -> Result<()> {
        let org_treasury = &mut ctx.accounts.org_treasury;

        org_treasury.set_inner(CvctAccount {
            owner: ctx.accounts.org.key(),
            cvct_mint: ctx.accounts.cvct_mint.key(),
            balance: 0,
        });

        Ok(())
    }

    pub fn create_payroll(ctx: Context<CreatePayroll>, interval: i64) -> Result<()> {
        let payroll = &mut ctx.accounts.payroll;

        payroll.set_inner(Payroll {
            org: ctx.accounts.org.key(),
            interval,
            last_run: 0,
            active: true,
        });

        Ok(())
    }

    pub fn add_payroll_member(ctx: Context<AddPayrollMember>, rate: u64) -> Result<()> {
        let payroll_member_state = &mut ctx.accounts.payroll_member_state;

        payroll_member_state.set_inner(PayrollMember {
            payroll: ctx.accounts.payroll.key(),
            cvct_wallet: ctx.accounts.recipient_cvct_account.key(),
            rate,
            last_paid: 0,
            active: true,
        });

        Ok(())
    }

    pub fn update_payroll_member(
        ctx: Context<UpdatePayrollMember>,
        new_rate: u64,
        active: bool,
    ) -> Result<()> {
        let member = &mut ctx.accounts.payroll_member_state;

        member.rate = new_rate;
        member.active = active;

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
    ZeroAmount,
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

#[derive(Accounts)]
pub struct DepositAndMint<'info> {
    #[account(mut)]
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(
        mut,
        constraint = vault.cvct_mint == cvct_mint.key() @ CvctError::InvalidVault,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        constraint = cvct_account.cvct_mint == cvct_mint.key(),
        constraint = cvct_account.owner == user.key() @ CvctError::Unauthorized,
    )]
    pub cvct_account: Account<'info, CvctAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_token_account.mint == cvct_mint.backing_mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_account.key() == vault.backing_token_account,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnAndWithdraw<'info> {
    #[account(mut)]
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(
        mut,
        seeds = [b"vault", cvct_mint.authority.as_ref()],
        bump,
        constraint = vault.cvct_mint == cvct_mint.key() @ CvctError::InvalidVault,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        constraint = cvct_account.cvct_mint == cvct_mint.key(),
        constraint = cvct_account.owner == user.key() @ CvctError::Unauthorized,
    )]
    pub cvct_account: Account<'info, CvctAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_token_account.mint == cvct_mint.backing_mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token_account.key() == vault.backing_token_account,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferCvct<'info> {
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(
        mut,
        constraint = from_cvct_account.cvct_mint == cvct_mint.key(),
        constraint = from_cvct_account.owner == from.key() @ CvctError::Unauthorized,
    )]
    pub from_cvct_account: Account<'info, CvctAccount>,
    #[account(
        mut,
        constraint = to_cvct_account.cvct_mint == cvct_mint.key(),
    )]
    pub to_cvct_account: Account<'info, CvctAccount>,
    pub from: Signer<'info>,
}

// ============================================
//                   Payroll
// ============================================

#[account]
#[derive(InitSpace)]
pub struct Organization {
    pub authority: Pubkey,
    pub cvct_mint: Pubkey,
    pub cvct_treasury_vault: Pubkey,
}

#[account]
#[derive(InitSpace)]

pub struct Payroll {
    pub org: Pubkey,
    pub interval: i64,
    pub last_run: i64,
    pub active: bool,
}

#[account]
#[derive(InitSpace)]

pub struct PayrollMember {
    pub payroll: Pubkey,
    pub cvct_wallet: Pubkey,
    pub rate: u64, // CVCT per interval
    pub last_paid: i64,
    pub active: bool,
}

#[derive(Accounts)]
pub struct InitOrg<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Organization::INIT_SPACE,
        seeds = [b"org", authority.key().as_ref()],
        bump,
    )]
    pub org: Account<'info, Organization>,
    pub cvct_mint: Account<'info, CvctMint>,
    pub treasury_vault: Account<'info, CvctAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitOrgTreasury<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        init,
        payer = admin,
        space = 8 + CvctAccount::INIT_SPACE,
        seeds = [b"org_treasury", org.key().as_ref()],
        bump,
    )]
    pub org_treasury: Account<'info, CvctAccount>,
    #[account(
        constraint = cvct_mint.key() == org.cvct_mint @ CvctError::InvalidVault,
    )]
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePayroll<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        init,
        payer = admin,
        space = 8 + Payroll::INIT_SPACE,
        seeds = [b"payroll", org.key().as_ref(), admin.key().as_ref()],
        bump,
    )]
    pub payroll: Account<'info, Payroll>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddPayrollMember<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        constraint = payroll.org == org.key() @ CvctError::Unauthorized,
    )]
    pub payroll: Account<'info, Payroll>,
    #[account(
        init,
        payer = admin,
        space = 8 + PayrollMember::INIT_SPACE,
        seeds = [b"payroll_member", payroll.key().as_ref(), recipient.key().as_ref()],
        bump,
    )]
    pub payroll_member_state: Account<'info, PayrollMember>,
    /// CHECK: Member's wallet address, validated by CVCT account constraint
    pub recipient: UncheckedAccount<'info>,
    #[account(
        constraint = recipient_cvct_account.owner == recipient.key() @ CvctError::Unauthorized,
        constraint = recipient_cvct_account.cvct_mint == org.cvct_mint @ CvctError::InvalidVault,
    )]
    pub recipient_cvct_account: Account<'info, CvctAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePayrollMember<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        constraint = payroll.org == org.key() @ CvctError::Unauthorized,
    )]
    pub payroll: Account<'info, Payroll>,
    #[account(
        mut,
        constraint = payroll_member_state.payroll == payroll.key() @ CvctError::Unauthorized,
    )]
    pub payroll_member_state: Account<'info, PayrollMember>,
    pub admin: Signer<'info>,
}

/*
require_keys_eq!(org.authority, signer.key());
require_keys_eq!(org.cvct_mint, cvct_mint.key());
require_keys_eq!(org.cvct_treasury_vault, treasury_vault.key());

*/
