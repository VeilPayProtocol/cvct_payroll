use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, as_euint128, e_add, e_ge, e_select, e_sub, new_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

declare_id!("Sd92uPUtbHdnoRFmi6xCEsLVh4Yg3KYcNbGXeSJVL5R");

/// Helper to call allow with accounts from remaining_accounts
/// remaining_accounts[offset] = allowance_account (mut)
/// remaining_accounts[offset+1] = allowed_address (readonly)
fn call_allow_from_remaining<'info>(
    inco_program: &AccountInfo<'info>,
    signer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    handle: Euint128,
    allowed_pubkey: Pubkey,
    account_offset: usize,
) -> Result<()> {
    if remaining_accounts.len() < account_offset + 2 {
        return Err(CvctError::InvalidAllowanceAccounts.into());
    }

    let allowance_account = &remaining_accounts[account_offset];
    let allowed_address = &remaining_accounts[account_offset + 1];

    let cpi_ctx = CpiContext::new(
        inco_program.clone(),
        Allow {
            allowance_account: allowance_account.clone(),
            signer: signer.clone(),
            allowed_address: allowed_address.clone(),
            system_program: system_program.clone(),
        },
    );

    allow(cpi_ctx, handle.0, true, allowed_pubkey)?;
    Ok(())
}

#[program]
pub mod cvct_payroll {
    use super::*;

    // ============================================
    //                   CVCT IX
    // ============================================

    pub fn initialize_cvct_mint(ctx: Context<InitializeCvctMint>) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.authority.to_account_info();

        // Initialize encrypted zero for total_supply
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let zero_supply = as_euint128(cpi_ctx, 0)?;

        // Initialize encrypted zero for vault's total_locked
        let cpi_ctx2 = CpiContext::new(inco, Operation { signer });
        let zero_locked = as_euint128(cpi_ctx2, 0)?;

        cvct_mint.set_inner(CvctMint {
            authority: ctx.accounts.authority.key(),
            backing_mint: ctx.accounts.backing_mint.key(),
            total_supply: zero_supply,
            decimals: ctx.accounts.backing_mint.decimals,
        });

        vault.set_inner(Vault {
            cvct_mint: ctx.accounts.cvct_mint.key(),
            backing_mint: ctx.accounts.backing_mint.key(),
            backing_token_account: ctx.accounts.vault_token_account.key(),
            total_locked: zero_locked,
        });

        Ok(())
    }

    pub fn initialize_cvct_account(ctx: Context<InitializeCvctAccount>) -> Result<()> {
        let cvct_account = &mut ctx.accounts.cvct_account;
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.owner.to_account_info();

        // Initialize encrypted zero balance
        let cpi_ctx = CpiContext::new(inco, Operation { signer });
        let zero_balance = as_euint128(cpi_ctx, 0)?;

        cvct_account.set_inner(CvctAccount {
            owner: ctx.accounts.owner.key(),
            cvct_mint: ctx.accounts.cvct_mint.key(),
            balance: zero_balance,
        });

        Ok(())
    }

    /// Deposit backing tokens and mint encrypted CVCT
    /// remaining_accounts: [allowance_account, owner_address] for granting balance access
    pub fn deposit_and_mint<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositAndMint<'info>>,
        amount: u64,
    ) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;
        let cvct_account = &mut ctx.accounts.cvct_account;
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.user.to_account_info();

        // 1. Transfer backing asset from user to vault (SPL Token transfer)
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

        // 2. Convert plaintext amount to encrypted value
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let encrypted_amount = as_euint128(cpi_ctx, amount as u128)?;

        // 3. Update encrypted balances using encrypted addition
        let cpi_ctx2 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_balance = e_add(cpi_ctx2, cvct_account.balance, encrypted_amount, 0u8)?;
        cvct_account.balance = new_balance;

        let cpi_ctx3 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_supply = e_add(cpi_ctx3, cvct_mint.total_supply, encrypted_amount, 0u8)?;
        cvct_mint.total_supply = new_supply;

        let cpi_ctx4 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_locked = e_add(cpi_ctx4, vault.total_locked, encrypted_amount, 0u8)?;
        vault.total_locked = new_locked;

        // 4. Grant allowance to owner for their new balance
        if ctx.remaining_accounts.len() >= 2 {
            call_allow_from_remaining(
                &inco,
                &signer,
                &ctx.accounts.system_program.to_account_info(),
                ctx.remaining_accounts,
                new_balance,
                cvct_account.owner,
                0,
            )?;
        }

        Ok(())
    }

    /// Burn encrypted CVCT and withdraw backing tokens
    /// remaining_accounts: [allowance_account, owner_address] for granting balance access
    pub fn burn_and_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, BurnAndWithdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;
        let cvct_account = &mut ctx.accounts.cvct_account;
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.user.to_account_info();

        // 1. Convert plaintext amount to encrypted value
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let encrypted_amount = as_euint128(cpi_ctx, amount as u128)?;

        // 2. Check if user has sufficient balance (encrypted comparison)
        let cpi_ctx2 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let has_sufficient = e_ge(cpi_ctx2, cvct_account.balance, encrypted_amount, 0u8)?;

        // 3. Conditionally set burn amount (0 if insufficient)
        let cpi_ctx3 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let zero_value = as_euint128(cpi_ctx3, 0)?;

        let cpi_ctx4 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let burn_amount = e_select(cpi_ctx4, has_sufficient, encrypted_amount, zero_value, 0u8)?;

        // 4. Update encrypted balances using encrypted subtraction
        let cpi_ctx5 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_balance = e_sub(cpi_ctx5, cvct_account.balance, burn_amount, 0u8)?;
        cvct_account.balance = new_balance;

        let cpi_ctx6 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_supply = e_sub(cpi_ctx6, cvct_mint.total_supply, burn_amount, 0u8)?;
        cvct_mint.total_supply = new_supply;

        let cpi_ctx7 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_locked = e_sub(cpi_ctx7, vault.total_locked, burn_amount, 0u8)?;
        vault.total_locked = new_locked;

        // 5. Transfer backing asset from vault to user
        // Note: This transfers the full amount - the e_select ensures encrypted state
        // is only updated if sufficient. For production, consider decryption verification.
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

        // 6. Grant allowance to owner for their new balance
        if ctx.remaining_accounts.len() >= 2 {
            call_allow_from_remaining(
                &inco,
                &signer,
                &ctx.accounts.system_program.to_account_info(),
                ctx.remaining_accounts,
                new_balance,
                cvct_account.owner,
                0,
            )?;
        }

        Ok(())
    }

    /// Transfer encrypted CVCT between accounts
    /// remaining_accounts:
    ///   [0] source_allowance_account (mut)
    ///   [1] source_owner_address (readonly)
    ///   [2] dest_allowance_account (mut)
    ///   [3] dest_owner_address (readonly)
    pub fn transfer_cvct<'info>(
        ctx: Context<'_, '_, '_, 'info, TransferCvct<'info>>,
        ciphertext: Vec<u8>,
        input_type: u8,
    ) -> Result<()> {
        let from_cvct_account = &mut ctx.accounts.from_cvct_account;
        let to_cvct_account = &mut ctx.accounts.to_cvct_account;
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.from.to_account_info();

        // Early return for self-transfer
        if from_cvct_account.key() == to_cvct_account.key() {
            return Ok(());
        }

        // 1. Convert ciphertext to encrypted amount
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let amount = new_euint128(cpi_ctx, ciphertext, input_type)?;

        // 2. Check if sender has sufficient balance (encrypted comparison)
        let cpi_ctx2 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let has_sufficient = e_ge(cpi_ctx2, from_cvct_account.balance, amount, 0u8)?;

        // 3. Conditionally set transfer amount (0 if insufficient)
        let cpi_ctx3 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let zero_value = as_euint128(cpi_ctx3, 0)?;

        let cpi_ctx4 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let transfer_amount = e_select(cpi_ctx4, has_sufficient, amount, zero_value, 0u8)?;

        // 4. Debit sender using encrypted subtraction
        let cpi_ctx5 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_source_balance = e_sub(cpi_ctx5, from_cvct_account.balance, transfer_amount, 0u8)?;
        from_cvct_account.balance = new_source_balance;

        // 5. Credit receiver using encrypted addition
        let cpi_ctx6 = CpiContext::new(
            inco.clone(),
            Operation {
                signer: signer.clone(),
            },
        );
        let new_dest_balance = e_add(cpi_ctx6, to_cvct_account.balance, transfer_amount, 0u8)?;
        to_cvct_account.balance = new_dest_balance;

        // 6. Grant allowance to source owner for their new balance
        if ctx.remaining_accounts.len() >= 2 {
            call_allow_from_remaining(
                &inco,
                &signer,
                &ctx.accounts.system_program.to_account_info(),
                ctx.remaining_accounts,
                new_source_balance,
                from_cvct_account.owner,
                0,
            )?;
        }

        // 7. Grant allowance to destination owner for their new balance
        if ctx.remaining_accounts.len() >= 4 {
            call_allow_from_remaining(
                &inco,
                &signer,
                &ctx.accounts.system_program.to_account_info(),
                ctx.remaining_accounts,
                new_dest_balance,
                to_cvct_account.owner,
                2,
            )?;
        }

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
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.admin.to_account_info();

        // Initialize encrypted zero balance
        let cpi_ctx = CpiContext::new(inco, Operation { signer });
        let zero_balance = as_euint128(cpi_ctx, 0)?;

        org_treasury.set_inner(CvctAccount {
            owner: ctx.accounts.org.key(),
            cvct_mint: ctx.accounts.cvct_mint.key(),
            balance: zero_balance,
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

    pub fn run_payroll_for_member(ctx: Context<RunPayrollForMember>) -> Result<()> {
        let payroll = &ctx.accounts.payroll;
        let member = &mut ctx.accounts.payroll_member_state;
        let org_treasury = &mut ctx.accounts.org_treasury;
        let member_cvct_account = &mut ctx.accounts.member_cvct_account;

        // 1. Check payroll is active
        require!(payroll.active, CvctError::PayrollNotActive);

        // 2. Check member is active
        require!(member.active, CvctError::MemberNotActive);

        // 3. Get current timestamp
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        // 4. Calculate periods owed since last payment
        let time_elapsed = now - member.last_paid;
        let periods_owed = if member.last_paid == 0 {
            // First payment - pay one period
            1_i64
        } else {
            time_elapsed / payroll.interval
        };

        // 5. Check if payment is due
        require!(periods_owed > 0, CvctError::PayrollNotDue);

        // 6. Calculate total owed
        let amount_owed = member.rate * (periods_owed as u64);

        // 7. Check treasury has sufficient funds
        require!(
            org_treasury.balance >= amount_owed,
            CvctError::InsufficientFunds
        );

        // 8. Transfer CVCT from treasury to member
        org_treasury.balance -= amount_owed;
        member_cvct_account.balance += amount_owed;

        // 9. Update last_paid to current time
        member.last_paid = now;

        Ok(())
    }

    pub fn pause_payroll(ctx: Context<PausePayroll>) -> Result<()> {
        ctx.accounts.payroll.active = false;
        Ok(())
    }

    pub fn resume_payroll(ctx: Context<ResumePayroll>) -> Result<()> {
        ctx.accounts.payroll.active = true;
        Ok(())
    }

    pub fn close_payroll(ctx: Context<ClosePayroll>) -> Result<()> {
        require!(!ctx.accounts.payroll.active, CvctError::MustPauseFirst);
        Ok(())
    }
}

// ============================================
//                   CVCT
// ============================================

#[account]
pub struct CvctMint {
    pub authority: Pubkey,
    pub backing_mint: Pubkey,
    pub total_supply: Euint128, // Encrypted total supply
    pub decimals: u8,
}

impl CvctMint {
    pub const LEN: usize = 32 + 32 + 32 + 1; // authority + backing_mint + Euint128 + decimals
}

#[account]
pub struct CvctAccount {
    pub owner: Pubkey,
    pub cvct_mint: Pubkey,
    pub balance: Euint128, // Encrypted balance
}

impl CvctAccount {
    pub const LEN: usize = 32 + 32 + 32; // owner + cvct_mint + Euint128
}

#[account]
pub struct Vault {
    pub cvct_mint: Pubkey,
    pub backing_mint: Pubkey,
    pub backing_token_account: Pubkey,
    pub total_locked: Euint128, // Encrypted total locked
}

impl Vault {
    pub const LEN: usize = 32 + 32 + 32 + 32; // cvct_mint + backing_mint + backing_token_account + Euint128
}

#[error_code]
pub enum CvctError {
    #[msg("Insufficient funds for operation")]
    InsufficientFunds,
    #[msg("Invariant violation detected")]
    InvariantViolation,
    #[msg("Invalid vault")]
    InvalidVault,
    #[msg("Unauthorized operation")]
    Unauthorized,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Payroll member is not active")]
    MemberNotActive,
    #[msg("Payroll is not active")]
    PayrollNotActive,
    #[msg("Payroll payment not due yet")]
    PayrollNotDue,
    #[msg("Payroll must be paused first")]
    MustPauseFirst,
    #[msg("Invalid allowance accounts provided")]
    InvalidAllowanceAccounts,
}

#[derive(Accounts)]
pub struct InitializeCvctMint<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CvctMint::LEN,
        seeds = [b"cvct_mint", authority.key().as_ref()],
        bump,
    )]
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::LEN,
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
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitializeCvctAccount<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + CvctAccount::LEN,
        seeds = [b"cvct_account", cvct_mint.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub cvct_account: Account<'info, CvctAccount>,
    pub cvct_mint: Account<'info, CvctMint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
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
    pub system_program: Program<'info, System>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
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
    pub system_program: Program<'info, System>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
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
    #[account(mut)]
    pub from: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
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
        space = 8 + CvctAccount::LEN,
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
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
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

#[derive(Accounts)]
pub struct RunPayrollForMember<'info> {
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
    #[account(
        mut,
        constraint = org_treasury.key() == org.cvct_treasury_vault @ CvctError::InvalidVault,
    )]
    pub org_treasury: Account<'info, CvctAccount>,
    #[account(
        mut,
        constraint = member_cvct_account.key() == payroll_member_state.cvct_wallet @ CvctError::Unauthorized,
    )]
    pub member_cvct_account: Account<'info, CvctAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct PausePayroll<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        mut,
        constraint = payroll.org == org.key() @ CvctError::Unauthorized,
    )]
    pub payroll: Account<'info, Payroll>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResumePayroll<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        mut,
        constraint = payroll.org == org.key() @ CvctError::Unauthorized,
    )]
    pub payroll: Account<'info, Payroll>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClosePayroll<'info> {
    #[account(
        constraint = org.authority == admin.key() @ CvctError::Unauthorized,
    )]
    pub org: Account<'info, Organization>,
    #[account(
        mut,
        close = admin,
        constraint = payroll.org == org.key() @ CvctError::Unauthorized,
    )]
    pub payroll: Account<'info, Payroll>,
    #[account(mut)]
    pub admin: Signer<'info>,
}
