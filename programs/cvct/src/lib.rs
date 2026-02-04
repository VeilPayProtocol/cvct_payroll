use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_MINT_STATE: u32 = comp_def_offset("init_mint_state");
const COMP_DEF_OFFSET_INIT_ACCOUNT_STATE: u32 = comp_def_offset("init_account_state");
const COMP_DEF_OFFSET_DEPOSIT_AND_MINT: u32 = comp_def_offset("deposit_and_mint");
const ENCRYPTED_U128_CIPHERTEXTS: usize = 1;

declare_id!("B4rLKdnQsFH2e4CBefgWsBXZ7xsX4ewb7QUiMim4Nbvj");

#[arcium_program]
pub mod cvct {
    use super::*;

    pub fn init_mint_state_comp_def(ctx: Context<InitMintStateCompDef>) -> Result<()> {
        // Registers the confidential circuit interface on-chain so Arcium can verify queued jobs.
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_account_state_comp_def(ctx: Context<InitAccountStateCompDef>) -> Result<()> {
        // Registers the confidential circuit interface for initializing CVCT accounts.
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_deposit_and_mint_comp_def(ctx: Context<InitDepositAndMintCompDef>) -> Result<()> {
        // Registers the confidential circuit interface for deposits.
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn initialize_cvct_mint(
        ctx: Context<InitializeCvctMint>,
        computation_offset: u64,
        authority_enc_pubkey: [u8; 32],
        authority_nonce: u128,
        vault_nonce: u128,
    ) -> Result<()> {
        // Cache keys needed after we mutably borrow accounts.
        let cvct_mint_key = ctx.accounts.cvct_mint.key();
        let vault_key = ctx.accounts.vault.key();
        let backing_mint_key = ctx.accounts.backing_mint.key();
        let vault_token_account_key = ctx.accounts.vault_token_account.key();
        let authority_key = ctx.accounts.authority.key();
        let decimals = ctx.accounts.backing_mint.decimals;
        {
            let cvct_mint = &mut ctx.accounts.cvct_mint;
            let vault = &mut ctx.accounts.vault;

            // Initialize public metadata immediately; encrypted fields are placeholders until callback.
            cvct_mint.set_inner(CvctMint {
                authority: authority_key,
                backing_mint: backing_mint_key,
                authority_enc_pubkey,
                total_supply: [[0u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
                total_supply_nonce: 0,
                decimals,
            });

            // Vault holds backing SPL tokens; encrypted total_locked updated in callback.
            vault.set_inner(Vault {
                cvct_mint: cvct_mint_key,
                backing_mint: backing_mint_key,
                backing_token_account: vault_token_account_key,
                total_locked: [[0u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
                total_locked_nonce: 0,
            });
        }

        // Build Arcium args: two Shared encryptions of 0, each with its own nonce.
        let args = ArgBuilder::new()
            .x25519_pubkey(authority_enc_pubkey)
            .plaintext_u128(authority_nonce)
            .x25519_pubkey(authority_enc_pubkey)
            .plaintext_u128(vault_nonce)
            .build();

        // Required by Arcium signer PDA; macro expects bump set on the account.
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Queue confidential computation and register callback to write encrypted outputs.
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![InitMintStateCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: cvct_mint_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: vault_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_mint_state")]
    pub fn init_mint_state_callback(
        ctx: Context<InitMintStateCallback>,
        output: SignedComputationOutputs<InitMintStateOutput>,
    ) -> Result<()> {
        // Verify Arcium output BLS signature, then extract encrypted results.
        let (total_supply, total_locked) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitMintStateOutput {
                field_0:
                    InitMintStateOutputStruct0 {
                        field_0: total_supply,
                        field_1: total_locked,
                    },
            }) => (total_supply, total_locked),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;

        // Persist encrypted totals + nonces into on-chain state.
        cvct_mint.total_supply = total_supply.ciphertexts;
        cvct_mint.total_supply_nonce = total_supply.nonce;
        vault.total_locked = total_locked.ciphertexts;
        vault.total_locked_nonce = total_locked.nonce;

        Ok(())
    }

    pub fn initialize_cvct_account(
        ctx: Context<InitializeCvctAccount>,
        computation_offset: u64,
        owner_enc_pubkey: [u8; 32],
        owner_nonce: u128,
    ) -> Result<()> {
        let cvct_account_key = ctx.accounts.cvct_account.key();
        let cvct_mint_key = ctx.accounts.cvct_mint.key();
        let owner_key = ctx.accounts.owner.key();

        {
            let cvct_account = &mut ctx.accounts.cvct_account;
            cvct_account.set_inner(CvctAccount {
                owner: owner_key,
                cvct_mint: cvct_mint_key,
                owner_enc_pubkey,
                balance: [[0u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
                balance_nonce: 0,
            });
        }

        // Build Arcium args to create an encrypted zero balance.
        let args = ArgBuilder::new()
            .x25519_pubkey(owner_enc_pubkey)
            .plaintext_u128(owner_nonce)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![InitAccountStateCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: cvct_account_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_account_state")]
    pub fn init_account_state_callback(
        ctx: Context<InitAccountStateCallback>,
        output: SignedComputationOutputs<InitAccountStateOutput>,
    ) -> Result<()> {
        let balance = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitAccountStateOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let cvct_account = &mut ctx.accounts.cvct_account;
        cvct_account.balance = balance.ciphertexts;
        cvct_account.balance_nonce = balance.nonce;

        Ok(())
    }
    pub fn deposit_and_mint(
        ctx: Context<DepositAndMint>,
        computation_offset: u64,
        amount: u64,
        owner_enc_pubkey: [u8; 32],
        owner_balance_nonce: u128,
        owner_new_balance_nonce: u128,
        mint_enc_pubkey: [u8; 32],
        mint_total_supply_nonce: u128,
        mint_new_total_supply_nonce: u128,
        vault_enc_pubkey: [u8; 32],
        vault_total_locked_nonce: u128,
        vault_new_total_locked_nonce: u128,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);

        // 1) Transfer backing tokens into the vault.
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

        // 2) Build Arcium args: read encrypted balance/supply/locked from accounts, add amount.
        let args = ArgBuilder::new()
            // Balance input from account data.
            .x25519_pubkey(owner_enc_pubkey)
            .plaintext_u128(owner_balance_nonce)
            .account(
                ctx.accounts.cvct_account.key(),
                8 + 32 + 32 + 32,
                (32 * ENCRYPTED_U128_CIPHERTEXTS) as u32,
            )
            // Plaintext amount.
            .plaintext_u128(amount as u128)
            // Output encryption context for balance.
            .x25519_pubkey(owner_enc_pubkey)
            .plaintext_u128(owner_new_balance_nonce)
            // Total supply input from mint.
            .x25519_pubkey(mint_enc_pubkey)
            .plaintext_u128(mint_total_supply_nonce)
            .account(
                ctx.accounts.cvct_mint.key(),
                8 + 32 + 32 + 32,
                (32 * ENCRYPTED_U128_CIPHERTEXTS) as u32,
            )
            // Output encryption context for total supply.
            .x25519_pubkey(mint_enc_pubkey)
            .plaintext_u128(mint_new_total_supply_nonce)
            // Total locked input from vault.
            .x25519_pubkey(vault_enc_pubkey)
            .plaintext_u128(vault_total_locked_nonce)
            .account(
                ctx.accounts.vault.key(),
                8 + 32 + 32 + 32,
                (32 * ENCRYPTED_U128_CIPHERTEXTS) as u32,
            )
            // Output encryption context for total locked.
            .x25519_pubkey(vault_enc_pubkey)
            .plaintext_u128(vault_new_total_locked_nonce)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![DepositAndMintCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.cvct_account.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.cvct_mint.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.vault.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "deposit_and_mint")]
    pub fn deposit_and_mint_callback(
        ctx: Context<DepositAndMintCallback>,
        output: SignedComputationOutputs<DepositAndMintOutput>,
    ) -> Result<()> {
        let (balance, total_supply, total_locked) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(DepositAndMintOutput {
                field_0:
                    DepositAndMintOutputStruct0 {
                        field_0: balance,
                        field_1: total_supply,
                        field_2: total_locked,
                    },
            }) => (balance, total_supply, total_locked),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let cvct_account = &mut ctx.accounts.cvct_account;
        let cvct_mint = &mut ctx.accounts.cvct_mint;
        let vault = &mut ctx.accounts.vault;

        cvct_account.balance = balance.ciphertexts;
        cvct_account.balance_nonce = balance.nonce;

        cvct_mint.total_supply = total_supply.ciphertexts;
        cvct_mint.total_supply_nonce = total_supply.nonce;

        vault.total_locked = total_locked.ciphertexts;
        vault.total_locked_nonce = total_locked.nonce;

        Ok(())
    }
}

#[account]
pub struct CvctMint {
    pub authority: Pubkey,
    pub backing_mint: Pubkey,
    /// X25519 pubkey used to encrypt/decrypt mint totals off-chain.
    pub authority_enc_pubkey: [u8; 32],
    /// Encrypted total supply (1 ciphertext for u128).
    pub total_supply: [[u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
    /// Nonce used with the encrypted total supply.
    pub total_supply_nonce: u128,
    pub decimals: u8,
}

impl CvctMint {
    pub const LEN: usize = 32 + 32 + 32 + (32 * ENCRYPTED_U128_CIPHERTEXTS) + 16 + 1;
}

#[account]
pub struct Vault {
    pub cvct_mint: Pubkey,
    pub backing_mint: Pubkey,
    /// SPL token account holding backing assets.
    pub backing_token_account: Pubkey,
    /// Encrypted total locked in the vault (1 ciphertext for u128).
    pub total_locked: [[u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
    /// Nonce used with the encrypted total locked.
    pub total_locked_nonce: u128,
}

impl Vault {
    pub const LEN: usize = 32 + 32 + 32 + (32 * ENCRYPTED_U128_CIPHERTEXTS) + 16;
}

#[account]
pub struct CvctAccount {
    pub owner: Pubkey,
    pub cvct_mint: Pubkey,
    /// X25519 pubkey used to encrypt/decrypt this account's balance.
    pub owner_enc_pubkey: [u8; 32],
    /// Encrypted balance (1 ciphertext for u128).
    pub balance: [[u8; 32]; ENCRYPTED_U128_CIPHERTEXTS],
    /// Nonce used with the encrypted balance.
    pub balance_nonce: u128,
}

impl CvctAccount {
    pub const LEN: usize = 32 + 32 + 32 + (32 * ENCRYPTED_U128_CIPHERTEXTS) + 16;
}

#[queue_computation_accounts("init_mint_state", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitializeCvctMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    /// Arcium signer PDA used to sign the queued computation.
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account identifies the Arcium execution environment.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_MINT_STATE))]
    /// On-chain computation definition for `init_mint_state`.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster state used for output verification.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    /// Fee pool used by Arcium.
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    /// Arcium clock account.
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = authority,
        space = 8 + CvctMint::LEN,
        seeds = [b"cvct_mint", authority.key().as_ref()],
        bump,
    )]
    /// CVCT mint metadata (encrypted totals updated by callback).
    pub cvct_mint: Box<Account<'info, CvctMint>>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::LEN,
        seeds = [b"vault", cvct_mint.key().as_ref()],
        bump,
    )]
    /// Vault metadata (encrypted total locked updated by callback).
    pub vault: Box<Account<'info, Vault>>,
    /// SPL mint that backs CVCT.
    pub backing_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = backing_mint,
        associated_token::authority = vault,
    )]
    /// ATA owned by vault PDA to hold backing SPL tokens.
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[callback_accounts("init_mint_state")]
#[derive(Accounts)]
pub struct InitMintStateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_MINT_STATE))]
    /// Same computation definition as queued instruction.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account for this computation.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster account used to verify Arcium output signature.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    /// CVCT mint to update encrypted total supply.
    pub cvct_mint: Box<Account<'info, CvctMint>>,
    #[account(mut)]
    /// Vault to update encrypted total locked.
    pub vault: Box<Account<'info, Vault>>,
}

#[queue_computation_accounts("init_account_state", owner)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitializeCvctAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = owner,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    /// Arcium signer PDA used to sign the queued computation.
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account identifies the Arcium execution environment.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_ACCOUNT_STATE))]
    /// On-chain computation definition for `init_account_state`.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster state used for output verification.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    /// Fee pool used by Arcium.
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    /// Arcium clock account.
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = owner,
        space = 8 + CvctAccount::LEN,
        seeds = [b"cvct_account", cvct_mint.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    /// CVCT account metadata (encrypted balance updated by callback).
    pub cvct_account: Box<Account<'info, CvctAccount>>,
    pub cvct_mint: Box<Account<'info, CvctMint>>,
}

#[callback_accounts("init_account_state")]
#[derive(Accounts)]
pub struct InitAccountStateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_ACCOUNT_STATE))]
    /// Same computation definition as queued instruction.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account for this computation.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster account used to verify Arcium output signature.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    /// CVCT account to update encrypted balance.
    pub cvct_account: Box<Account<'info, CvctAccount>>,
}

#[queue_computation_accounts("deposit_and_mint", user)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct DepositAndMint<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = user,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    /// Arcium signer PDA used to sign the queued computation.
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account identifies the Arcium execution environment.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT_AND_MINT))]
    /// On-chain computation definition for `deposit_and_mint`.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster state used for output verification.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    /// Fee pool used by Arcium.
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    /// Arcium clock account.
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        constraint = cvct_mint.authority == user.key() @ ErrorCode::Unauthorized,
    )]
    pub cvct_mint: Box<Account<'info, CvctMint>>,
    #[account(
        mut,
        seeds = [b"vault", cvct_mint.key().as_ref()],
        bump,
        constraint = vault.cvct_mint == cvct_mint.key() @ ErrorCode::InvalidVault,
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        seeds = [b"cvct_account", cvct_mint.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = cvct_account.cvct_mint == cvct_mint.key(),
        constraint = cvct_account.owner == user.key() @ ErrorCode::Unauthorized,
    )]
    pub cvct_account: Box<Account<'info, CvctAccount>>,
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

#[callback_accounts("deposit_and_mint")]
#[derive(Accounts)]
pub struct DepositAndMintCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT_AND_MINT))]
    /// Same computation definition as queued instruction.
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    /// MXE account for this computation.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// Cluster account used to verify Arcium output signature.
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    /// CVCT account to update encrypted balance.
    pub cvct_account: Box<Account<'info, CvctAccount>>,
    #[account(mut)]
    /// CVCT mint to update encrypted total supply.
    pub cvct_mint: Box<Account<'info, CvctMint>>,
    #[account(mut)]
    /// Vault to update encrypted total locked.
    pub vault: Box<Account<'info, Vault>>,
}

#[init_computation_definition_accounts("init_mint_state", payer)]
#[derive(Accounts)]
pub struct InitMintStateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    /// MXE account required to initialize comp def.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("init_account_state", payer)]
#[derive(Accounts)]
pub struct InitAccountStateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    /// MXE account required to initialize comp def.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("deposit_and_mint", payer)]
#[derive(Accounts)]
pub struct InitDepositAndMintCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    /// MXE account required to initialize comp def.
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid vault")]
    InvalidVault,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
