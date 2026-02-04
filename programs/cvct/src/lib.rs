use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_MINT_STATE: u32 = comp_def_offset("init_mint_state");
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
    pub const LEN: usize =
        32 + 32 + 32 + (32 * ENCRYPTED_U128_CIPHERTEXTS) + 16 + 1;
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
    pub const LEN: usize =
        32 + 32 + 32 + (32 * ENCRYPTED_U128_CIPHERTEXTS) + 16;
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

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}
