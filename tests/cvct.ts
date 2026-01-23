import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { CvctPayroll } from "../target/types/cvct_payroll";
import { expect } from "chai";

describe("CVCT Tests", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.CvctPayroll as Program<CvctPayroll>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;

  let authority: Keypair;
  let user: Keypair;
  let backingMint: PublicKey;
  let cvctMintPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultTokenAccount: PublicKey;
  let userTokenAccount: PublicKey;
  let cvctAccountPda: PublicKey;

  const DEPOSIT_AMOUNT = 1_000_000_000; // 1 token with 9 decimals

  // Helper function to send and confirm transactions with new API
  async function sendAndConfirmTx(tx: Transaction): Promise<string> {
    const latestBlockhash = await connection.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = provider.wallet.publicKey;
    const signedTx = await provider.wallet.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    return signature;
  }

  before(async () => {
    // Create authority and user keypairs
    authority = Keypair.generate();
    user = Keypair.generate();

    // Fund authority and user from provider wallet
    const fundingTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: authority.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: user.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTx(fundingTx);

    // Create backing mint (e.g., USDC mock)
    backingMint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Derive PDAs
    [cvctMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cvct_mint"), authority.publicKey.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      program.programId
    );
  });

  // ============================================
  //          Initialize CVCT Mint Tests
  // ============================================

  describe("initialize_cvct_mint", () => {
    it("Happy path: successfully initializes CVCT mint and vault", async () => {
      // Get the vault's ATA address
      vaultTokenAccount = await anchor.utils.token.associatedAddress({
        mint: backingMint,
        owner: vaultPda,
      });

      const tx = await program.methods
        .initializeCvctMint()
        .accountsPartial({
          cvctMint: cvctMintPda,
          vault: vaultPda,
          backingMint: backingMint,
          vaultTokenAccount: vaultTokenAccount,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();

      console.log("Initialize CVCT Mint tx:", tx);

      // Verify CVCT mint state
      const cvctMintAccount = await program.account.cvctMint.fetch(cvctMintPda);
      expect(cvctMintAccount.authority.toString()).to.equal(
        authority.publicKey.toString()
      );
      expect(cvctMintAccount.backingMint.toString()).to.equal(
        backingMint.toString()
      );
      expect(cvctMintAccount.totalSupply.toNumber()).to.equal(0);

      // Verify vault state
      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.cvctMint.toString()).to.equal(cvctMintPda.toString());
      expect(vaultAccount.backingMint.toString()).to.equal(
        backingMint.toString()
      );
      expect(vaultAccount.totalLocked.toNumber()).to.equal(0);

      // Verify invariant: total_supply == total_locked (both 0)
      expect(cvctMintAccount.totalSupply.toNumber()).to.equal(
        vaultAccount.totalLocked.toNumber()
      );
    });

    it("Unhappy path: fails to reinitialize existing CVCT mint", async () => {
      try {
        await program.methods
          .initializeCvctMint()
          .accountsPartial({
            cvctMint: cvctMintPda,
            vault: vaultPda,
            backingMint: backingMint,
            vaultTokenAccount: vaultTokenAccount,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Account already initialized - this is expected
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ============================================
  //        Initialize CVCT Account Tests
  // ============================================

  describe("initialize_cvct_account", () => {
    it("Happy path: successfully creates user CVCT account", async () => {
      [cvctAccountPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          user.publicKey.toBuffer(),
        ],
        program.programId
      );

      const tx = await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: cvctAccountPda,
          cvctMint: cvctMintPda,
          owner: user.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Initialize CVCT Account tx:", tx);

      // Verify CVCT account state
      const cvctAccount = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      expect(cvctAccount.owner.toString()).to.equal(user.publicKey.toString());
      expect(cvctAccount.cvctMint.toString()).to.equal(cvctMintPda.toString());
      expect(cvctAccount.balance.toNumber()).to.equal(0);
    });

    it("Unhappy path: fails to reinitialize existing CVCT account", async () => {
      try {
        await program.methods
          .initializeCvctAccount()
          .accountsPartial({
            cvctAccount: cvctAccountPda,
            cvctMint: cvctMintPda,
            owner: user.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ============================================
  //          Deposit and Mint Tests
  // ============================================

  describe("deposit_and_mint", () => {
    before(async () => {
      // Create user's token account and mint some backing tokens
      const userAta = await getOrCreateAssociatedTokenAccount(
        connection,
        user,
        backingMint,
        user.publicKey
      );
      userTokenAccount = userAta.address;

      // Mint backing tokens to user
      await mintTo(
        connection,
        authority,
        backingMint,
        userTokenAccount,
        authority,
        DEPOSIT_AMOUNT * 2 // Mint extra for multiple tests
      );
    });

    it("Happy path: deposits backing tokens and mints CVCT", async () => {
      const cvctMintBefore = await program.account.cvctMint.fetch(cvctMintPda);
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const cvctAccountBefore = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const vaultTokenBefore = await getAccount(connection, vaultTokenAccount);

      const tx = await program.methods
        .depositAndMint(new anchor.BN(DEPOSIT_AMOUNT))
        .accountsPartial({
          cvctMint: cvctMintPda,
          vault: vaultPda,
          cvctAccount: cvctAccountPda,
          user: user.publicKey,
          userTokenAccount: userTokenAccount,
          vaultTokenAccount: vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("Deposit and Mint tx:", tx);

      // Verify state changes
      const cvctMintAfter = await program.account.cvctMint.fetch(cvctMintPda);
      const vaultAfter = await program.account.vault.fetch(vaultPda);
      const cvctAccountAfter = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const vaultTokenAfter = await getAccount(connection, vaultTokenAccount);

      // Check balances increased correctly
      expect(cvctAccountAfter.balance.toNumber()).to.equal(
        cvctAccountBefore.balance.toNumber() + DEPOSIT_AMOUNT
      );
      expect(cvctMintAfter.totalSupply.toNumber()).to.equal(
        cvctMintBefore.totalSupply.toNumber() + DEPOSIT_AMOUNT
      );
      expect(vaultAfter.totalLocked.toNumber()).to.equal(
        vaultBefore.totalLocked.toNumber() + DEPOSIT_AMOUNT
      );

      // Verify token transfer occurred
      expect(Number(vaultTokenAfter.amount)).to.equal(
        Number(vaultTokenBefore.amount) + DEPOSIT_AMOUNT
      );

      // INVARIANT CHECK: total_supply == total_locked
      expect(cvctMintAfter.totalSupply.toNumber()).to.equal(
        vaultAfter.totalLocked.toNumber()
      );
    });

    it("Unhappy path: fails when user has insufficient backing tokens", async () => {
      // Try to deposit more than user has
      const hugeAmount = DEPOSIT_AMOUNT * 1000;

      try {
        await program.methods
          .depositAndMint(new anchor.BN(hugeAmount))
          .accountsPartial({
            cvctMint: cvctMintPda,
            vault: vaultPda,
            cvctAccount: cvctAccountPda,
            user: user.publicKey,
            userTokenAccount: userTokenAccount,
            vaultTokenAccount: vaultTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Token transfer should fail due to insufficient funds
        expect(err.toString()).to.include("insufficient");
      }
    });
  });

  // ============================================
  //          Burn and Withdraw Tests
  // ============================================

  describe("burn_and_withdraw", () => {
    it("Happy path: burns CVCT and withdraws backing tokens", async () => {
      const withdrawAmount = DEPOSIT_AMOUNT / 2;

      const cvctMintBefore = await program.account.cvctMint.fetch(cvctMintPda);
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const cvctAccountBefore = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const userTokenBefore = await getAccount(connection, userTokenAccount);

      const tx = await program.methods
        .burnAndWithdraw(new anchor.BN(withdrawAmount))
        .accountsPartial({
          cvctMint: cvctMintPda,
          vault: vaultPda,
          cvctAccount: cvctAccountPda,
          user: user.publicKey,
          userTokenAccount: userTokenAccount,
          vaultTokenAccount: vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("Burn and Withdraw tx:", tx);

      // Verify state changes
      const cvctMintAfter = await program.account.cvctMint.fetch(cvctMintPda);
      const vaultAfter = await program.account.vault.fetch(vaultPda);
      const cvctAccountAfter = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const userTokenAfter = await getAccount(connection, userTokenAccount);

      // Check balances decreased correctly
      expect(cvctAccountAfter.balance.toNumber()).to.equal(
        cvctAccountBefore.balance.toNumber() - withdrawAmount
      );
      expect(cvctMintAfter.totalSupply.toNumber()).to.equal(
        cvctMintBefore.totalSupply.toNumber() - withdrawAmount
      );
      expect(vaultAfter.totalLocked.toNumber()).to.equal(
        vaultBefore.totalLocked.toNumber() - withdrawAmount
      );

      // Verify token transfer occurred
      expect(Number(userTokenAfter.amount)).to.equal(
        Number(userTokenBefore.amount) + withdrawAmount
      );

      // INVARIANT CHECK: total_supply == total_locked
      expect(cvctMintAfter.totalSupply.toNumber()).to.equal(
        vaultAfter.totalLocked.toNumber()
      );
    });

    it("Unhappy path: fails when user has insufficient CVCT balance", async () => {
      const cvctAccount = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const excessAmount = cvctAccount.balance.toNumber() + 1;

      try {
        await program.methods
          .burnAndWithdraw(new anchor.BN(excessAmount))
          .accountsPartial({
            cvctMint: cvctMintPda,
            vault: vaultPda,
            cvctAccount: cvctAccountPda,
            user: user.publicKey,
            userTokenAccount: userTokenAccount,
            vaultTokenAccount: vaultTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Should fail with InsufficientFunds error
        expect(err.toString()).to.include("InsufficientFunds");
      }
    });
  });

  // ============================================
  //          Transfer CVCT Tests
  // ============================================

  describe("transfer_cvct", () => {
    let recipient: Keypair;
    let recipientCvctAccountPda: PublicKey;

    before(async () => {
      // Create recipient keypair
      recipient = Keypair.generate();

      // Fund recipient from provider wallet
      const fundRecipientTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: recipient.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundRecipientTx);

      // Derive recipient's CVCT account PDA
      [recipientCvctAccountPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          recipient.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Initialize recipient's CVCT account
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: recipientCvctAccountPda,
          cvctMint: cvctMintPda,
          owner: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([recipient])
        .rpc();
    });

    it("Happy path: transfers CVCT between accounts", async () => {
      const transferAmount = 100_000_000; // 0.1 CVCT

      const fromAccountBefore = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const toAccountBefore = await program.account.cvctAccount.fetch(
        recipientCvctAccountPda
      );
      const cvctMintBefore = await program.account.cvctMint.fetch(cvctMintPda);

      const tx = await program.methods
        .transferCvct(new anchor.BN(transferAmount))
        .accountsPartial({
          cvctMint: cvctMintPda,
          fromCvctAccount: cvctAccountPda,
          toCvctAccount: recipientCvctAccountPda,
          from: user.publicKey,
        })
        .signers([user])
        .rpc();

      console.log("Transfer CVCT tx:", tx);

      // Verify state changes
      const fromAccountAfter = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const toAccountAfter = await program.account.cvctAccount.fetch(
        recipientCvctAccountPda
      );
      const cvctMintAfter = await program.account.cvctMint.fetch(cvctMintPda);

      // Check balances changed correctly
      expect(fromAccountAfter.balance.toNumber()).to.equal(
        fromAccountBefore.balance.toNumber() - transferAmount
      );
      expect(toAccountAfter.balance.toNumber()).to.equal(
        toAccountBefore.balance.toNumber() + transferAmount
      );

      // INVARIANT: total_supply unchanged (no minting/burning)
      expect(cvctMintAfter.totalSupply.toNumber()).to.equal(
        cvctMintBefore.totalSupply.toNumber()
      );
    });

    it("Unhappy path: fails when sender has insufficient CVCT balance", async () => {
      const fromAccount = await program.account.cvctAccount.fetch(
        cvctAccountPda
      );
      const excessAmount = fromAccount.balance.toNumber() + 1;

      try {
        await program.methods
          .transferCvct(new anchor.BN(excessAmount))
          .accountsPartial({
            cvctMint: cvctMintPda,
            fromCvctAccount: cvctAccountPda,
            toCvctAccount: recipientCvctAccountPda,
            from: user.publicKey,
          })
          .signers([user])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Should fail with InsufficientFunds error
        expect(err.toString()).to.include("InsufficientFunds");
      }
    });
  });

  // ============================================
  //          Authorization Tests
  // ============================================

  describe("authorization checks", () => {
    it("Unhappy path: unauthorized user cannot withdraw from another's account", async () => {
      const attacker = Keypair.generate();

      // Fund attacker from provider wallet
      const fundAttackerTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: attacker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundAttackerTx);

      // Create attacker's token account
      const attackerAta = await getOrCreateAssociatedTokenAccount(
        connection,
        attacker,
        backingMint,
        attacker.publicKey
      );

      try {
        await program.methods
          .burnAndWithdraw(new anchor.BN(100))
          .accountsPartial({
            cvctMint: cvctMintPda,
            vault: vaultPda,
            cvctAccount: cvctAccountPda, // User's account, not attacker's
            user: attacker.publicKey,
            userTokenAccount: attackerAta.address,
            vaultTokenAccount: vaultTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Should fail with Unauthorized error
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================
  //          Init Organization Tests
  // ============================================

  describe("init_org", () => {
    let orgAdmin: Keypair;
    let orgPda: PublicKey;
    let orgTreasuryPda: PublicKey;

    before(async () => {
      // Create org admin keypair
      orgAdmin = Keypair.generate();

      // Fund org admin from provider wallet
      const fundOrgAdminTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: orgAdmin.publicKey,
          lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundOrgAdminTx);

      // Derive org PDA
      [orgPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), orgAdmin.publicKey.toBuffer()],
        program.programId
      );

      // Derive org treasury CVCT account PDA
      [orgTreasuryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          orgAdmin.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Initialize org's treasury CVCT account
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: orgTreasuryPda,
          cvctMint: cvctMintPda,
          owner: orgAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdmin])
        .rpc();
    });

    it("Happy path: successfully initializes an organization", async () => {
      const tx = await program.methods
        .initOrg()
        .accountsPartial({
          org: orgPda,
          cvctMint: cvctMintPda,
          treasuryVault: orgTreasuryPda,
          authority: orgAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdmin])
        .rpc();

      console.log("Init Org tx:", tx);

      // Verify org state
      const orgAccount = await program.account.organization.fetch(orgPda);
      expect(orgAccount.authority.toString()).to.equal(
        orgAdmin.publicKey.toString()
      );
      expect(orgAccount.cvctMint.toString()).to.equal(cvctMintPda.toString());
      expect(orgAccount.cvctTreasuryVault.toString()).to.equal(
        orgTreasuryPda.toString()
      );
    });

    it("Unhappy path: fails to reinitialize existing organization", async () => {
      try {
        await program.methods
          .initOrg()
          .accountsPartial({
            org: orgPda,
            cvctMint: cvctMintPda,
            treasuryVault: orgTreasuryPda,
            authority: orgAdmin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([orgAdmin])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        // Account already initialized - this is expected
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ============================================
  //          Init Org Treasury Tests
  // ============================================

  describe("init_org_treasury", () => {
    let orgAdmin2: Keypair;
    let org2Pda: PublicKey;
    let org2TreasuryPda: PublicKey;
    let orgTreasuryPda2: PublicKey;

    before(async () => {
      // Create a second org admin for these tests
      orgAdmin2 = Keypair.generate();

      // Fund org admin
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: orgAdmin2.publicKey,
          lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Derive PDAs
      [org2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), orgAdmin2.publicKey.toBuffer()],
        program.programId
      );

      [org2TreasuryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          orgAdmin2.publicKey.toBuffer(),
        ],
        program.programId
      );

      [orgTreasuryPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("org_treasury"), org2Pda.toBuffer()],
        program.programId
      );

      // Initialize org's personal treasury CVCT account first
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: org2TreasuryPda,
          cvctMint: cvctMintPda,
          owner: orgAdmin2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdmin2])
        .rpc();

      // Initialize org
      await program.methods
        .initOrg()
        .accountsPartial({
          org: org2Pda,
          cvctMint: cvctMintPda,
          treasuryVault: org2TreasuryPda,
          authority: orgAdmin2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdmin2])
        .rpc();
    });

    it("Happy path: successfully initializes org treasury", async () => {
      const tx = await program.methods
        .initOrgTreasury()
        .accountsPartial({
          org: org2Pda,
          orgTreasury: orgTreasuryPda2,
          cvctMint: cvctMintPda,
          admin: orgAdmin2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdmin2])
        .rpc();

      console.log("Init Org Treasury tx:", tx);

      // Verify treasury state
      const treasuryAccount = await program.account.cvctAccount.fetch(
        orgTreasuryPda2
      );
      expect(treasuryAccount.owner.toString()).to.equal(org2Pda.toString());
      expect(treasuryAccount.cvctMint.toString()).to.equal(
        cvctMintPda.toString()
      );
      expect(treasuryAccount.balance.toNumber()).to.equal(0);
    });

    it("Unhappy path: non-admin cannot initialize org treasury", async () => {
      const attacker = Keypair.generate();
      const victimOrgAdmin = Keypair.generate();

      // Fund attacker and victim org admin
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: attacker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: victimOrgAdmin.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Create a fresh org for the victim (without treasury initialized)
      const [victimOrgPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), victimOrgAdmin.publicKey.toBuffer()],
        program.programId
      );

      // Create a CVCT account for victim org's treasury vault (required for init_org)
      const [victimTreasuryVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("cvct_account"), cvctMintPda.toBuffer(), victimOrgAdmin.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: victimTreasuryVaultPda,
          cvctMint: cvctMintPda,
          owner: victimOrgAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([victimOrgAdmin])
        .rpc();

      // Initialize the victim org
      await program.methods
        .initOrg()
        .accountsPartial({
          org: victimOrgPda,
          cvctMint: cvctMintPda,
          treasuryVault: victimTreasuryVaultPda,
          authority: victimOrgAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([victimOrgAdmin])
        .rpc();

      // Derive the treasury PDA for victim org (which attacker is not admin of)
      const [victimOrgTreasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org_treasury"), victimOrgPda.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .initOrgTreasury()
          .accountsPartial({
            org: victimOrgPda, // Trying to use victim's org
            orgTreasury: victimOrgTreasuryPda,
            cvctMint: cvctMintPda,
            admin: attacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================
  //          Create Payroll Tests
  // ============================================

  describe("create_payroll", () => {
    let payrollPda: PublicKey;
    let orgAdminForPayroll: Keypair;
    let orgForPayrollPda: PublicKey;
    let orgForPayrollTreasuryPda: PublicKey;

    before(async () => {
      // Use a fresh org admin for payroll tests
      orgAdminForPayroll = Keypair.generate();

      // Fund org admin
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: orgAdminForPayroll.publicKey,
          lamports: 3 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Derive PDAs
      [orgForPayrollPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), orgAdminForPayroll.publicKey.toBuffer()],
        program.programId
      );

      [orgForPayrollTreasuryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          orgAdminForPayroll.publicKey.toBuffer(),
        ],
        program.programId
      );

      [payrollPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll"),
          orgForPayrollPda.toBuffer(),
          orgAdminForPayroll.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Initialize treasury account
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: orgForPayrollTreasuryPda,
          cvctMint: cvctMintPda,
          owner: orgAdminForPayroll.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdminForPayroll])
        .rpc();

      // Initialize org
      await program.methods
        .initOrg()
        .accountsPartial({
          org: orgForPayrollPda,
          cvctMint: cvctMintPda,
          treasuryVault: orgForPayrollTreasuryPda,
          authority: orgAdminForPayroll.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdminForPayroll])
        .rpc();
    });

    it("Happy path: successfully creates a payroll", async () => {
      const interval = new anchor.BN(86400); // 1 day in seconds

      const tx = await program.methods
        .createPayroll(interval)
        .accountsPartial({
          org: orgForPayrollPda,
          payroll: payrollPda,
          admin: orgAdminForPayroll.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([orgAdminForPayroll])
        .rpc();

      console.log("Create Payroll tx:", tx);

      // Verify payroll state
      const payrollAccount = await program.account.payroll.fetch(payrollPda);
      expect(payrollAccount.org.toString()).to.equal(
        orgForPayrollPda.toString()
      );
      expect(payrollAccount.interval.toNumber()).to.equal(86400);
      expect(payrollAccount.lastRun.toNumber()).to.equal(0);
      expect(payrollAccount.active).to.equal(true);
    });

    it("Unhappy path: non-admin cannot create payroll", async () => {
      const attacker = Keypair.generate();

      // Fund attacker
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: attacker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      const [attackerPayrollPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll"),
          orgForPayrollPda.toBuffer(),
          attacker.publicKey.toBuffer(),
        ],
        program.programId
      );

      try {
        await program.methods
          .createPayroll(new anchor.BN(86400))
          .accountsPartial({
            org: orgForPayrollPda,
            payroll: attackerPayrollPda,
            admin: attacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================
  //          Add Payroll Member Tests
  // ============================================

  describe("add_payroll_member", () => {
    let memberAdmin: Keypair;
    let memberOrgPda: PublicKey;
    let memberOrgTreasuryPda: PublicKey;
    let memberPayrollPda: PublicKey;
    let employeeWallet: Keypair;
    let employeeCvctAccountPda: PublicKey;
    let payrollMemberPda: PublicKey;

    before(async () => {
      // Setup org admin
      memberAdmin = Keypair.generate();

      // Fund admin
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: memberAdmin.publicKey,
          lamports: 3 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Derive PDAs
      [memberOrgPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), memberAdmin.publicKey.toBuffer()],
        program.programId
      );

      [memberOrgTreasuryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          memberAdmin.publicKey.toBuffer(),
        ],
        program.programId
      );

      [memberPayrollPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll"),
          memberOrgPda.toBuffer(),
          memberAdmin.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Setup employee
      employeeWallet = Keypair.generate();

      // Fund employee
      const fundEmployeeTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: employeeWallet.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundEmployeeTx);

      [employeeCvctAccountPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          employeeWallet.publicKey.toBuffer(),
        ],
        program.programId
      );

      [payrollMemberPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll_member"),
          memberPayrollPda.toBuffer(),
          employeeWallet.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Initialize treasury
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: memberOrgTreasuryPda,
          cvctMint: cvctMintPda,
          owner: memberAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([memberAdmin])
        .rpc();

      // Initialize org
      await program.methods
        .initOrg()
        .accountsPartial({
          org: memberOrgPda,
          cvctMint: cvctMintPda,
          treasuryVault: memberOrgTreasuryPda,
          authority: memberAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([memberAdmin])
        .rpc();

      // Create payroll
      await program.methods
        .createPayroll(new anchor.BN(86400))
        .accountsPartial({
          org: memberOrgPda,
          payroll: memberPayrollPda,
          admin: memberAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([memberAdmin])
        .rpc();

      // Initialize employee's CVCT account
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: employeeCvctAccountPda,
          cvctMint: cvctMintPda,
          owner: employeeWallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([employeeWallet])
        .rpc();
    });

    it("Happy path: successfully adds a payroll member", async () => {
      const rate = new anchor.BN(1000_000_000); // 1 CVCT per interval

      const tx = await program.methods
        .addPayrollMember(rate)
        .accountsPartial({
          org: memberOrgPda,
          payroll: memberPayrollPda,
          payrollMemberState: payrollMemberPda,
          recipient: employeeWallet.publicKey,
          recipientCvctAccount: employeeCvctAccountPda,
          admin: memberAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([memberAdmin])
        .rpc();

      console.log("Add Payroll Member tx:", tx);

      // Verify member state
      const memberAccount = await program.account.payrollMember.fetch(
        payrollMemberPda
      );
      expect(memberAccount.payroll.toString()).to.equal(
        memberPayrollPda.toString()
      );
      expect(memberAccount.cvctWallet.toString()).to.equal(
        employeeCvctAccountPda.toString()
      );
      expect(memberAccount.rate.toNumber()).to.equal(1000_000_000);
      expect(memberAccount.lastPaid.toNumber()).to.equal(0);
      expect(memberAccount.active).to.equal(true);
    });

    it("Unhappy path: non-admin cannot add payroll member", async () => {
      const attacker = Keypair.generate();
      const newEmployee = Keypair.generate();

      // Fund attacker and new employee
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: attacker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: newEmployee.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Initialize new employee's CVCT account
      const [newEmployeeCvctPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          newEmployee.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: newEmployeeCvctPda,
          cvctMint: cvctMintPda,
          owner: newEmployee.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([newEmployee])
        .rpc();

      const [newMemberPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll_member"),
          memberPayrollPda.toBuffer(),
          newEmployee.publicKey.toBuffer(),
        ],
        program.programId
      );

      try {
        await program.methods
          .addPayrollMember(new anchor.BN(500_000_000))
          .accountsPartial({
            org: memberOrgPda,
            payroll: memberPayrollPda,
            payrollMemberState: newMemberPda,
            recipient: newEmployee.publicKey,
            recipientCvctAccount: newEmployeeCvctPda,
            admin: attacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================
  //          Update Payroll Member Tests
  // ============================================

  describe("update_payroll_member", () => {
    let updateAdmin: Keypair;
    let updateOrgPda: PublicKey;
    let updateOrgTreasuryPda: PublicKey;
    let updatePayrollPda: PublicKey;
    let updateEmployeeWallet: Keypair;
    let updateEmployeeCvctPda: PublicKey;
    let updateMemberPda: PublicKey;

    before(async () => {
      // Setup org admin
      updateAdmin = Keypair.generate();

      // Fund admin
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: updateAdmin.publicKey,
          lamports: 3 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      // Derive PDAs
      [updateOrgPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("org"), updateAdmin.publicKey.toBuffer()],
        program.programId
      );

      [updateOrgTreasuryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          updateAdmin.publicKey.toBuffer(),
        ],
        program.programId
      );

      [updatePayrollPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll"),
          updateOrgPda.toBuffer(),
          updateAdmin.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Setup employee
      updateEmployeeWallet = Keypair.generate();

      // Fund employee
      const fundEmployeeTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: updateEmployeeWallet.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundEmployeeTx);

      [updateEmployeeCvctPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cvct_account"),
          cvctMintPda.toBuffer(),
          updateEmployeeWallet.publicKey.toBuffer(),
        ],
        program.programId
      );

      [updateMemberPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("payroll_member"),
          updatePayrollPda.toBuffer(),
          updateEmployeeWallet.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Initialize treasury
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: updateOrgTreasuryPda,
          cvctMint: cvctMintPda,
          owner: updateAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([updateAdmin])
        .rpc();

      // Initialize org
      await program.methods
        .initOrg()
        .accountsPartial({
          org: updateOrgPda,
          cvctMint: cvctMintPda,
          treasuryVault: updateOrgTreasuryPda,
          authority: updateAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([updateAdmin])
        .rpc();

      // Create payroll
      await program.methods
        .createPayroll(new anchor.BN(86400))
        .accountsPartial({
          org: updateOrgPda,
          payroll: updatePayrollPda,
          admin: updateAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([updateAdmin])
        .rpc();

      // Initialize employee's CVCT account
      await program.methods
        .initializeCvctAccount()
        .accountsPartial({
          cvctAccount: updateEmployeeCvctPda,
          cvctMint: cvctMintPda,
          owner: updateEmployeeWallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([updateEmployeeWallet])
        .rpc();

      // Add payroll member
      await program.methods
        .addPayrollMember(new anchor.BN(1000_000_000))
        .accountsPartial({
          org: updateOrgPda,
          payroll: updatePayrollPda,
          payrollMemberState: updateMemberPda,
          recipient: updateEmployeeWallet.publicKey,
          recipientCvctAccount: updateEmployeeCvctPda,
          admin: updateAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([updateAdmin])
        .rpc();
    });

    it("Happy path: successfully updates payroll member", async () => {
      const newRate = new anchor.BN(2000_000_000); // Double the rate
      const active = false; // Deactivate

      const tx = await program.methods
        .updatePayrollMember(newRate, active)
        .accountsPartial({
          org: updateOrgPda,
          payroll: updatePayrollPda,
          member: updateMemberPda,
          admin: updateAdmin.publicKey,
        })
        .signers([updateAdmin])
        .rpc();

      console.log("Update Payroll Member tx:", tx);

      // Verify updated state
      const memberAccount = await program.account.payrollMember.fetch(
        updateMemberPda
      );
      expect(memberAccount.rate.toNumber()).to.equal(2000_000_000);
      expect(memberAccount.active).to.equal(false);
    });

    it("Unhappy path: non-admin cannot update payroll member", async () => {
      const attacker = Keypair.generate();

      // Fund attacker
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: attacker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTx(fundTx);

      try {
        await program.methods
          .updatePayrollMember(new anchor.BN(999_000_000), true)
          .accountsPartial({
            org: updateOrgPda,
            payroll: updatePayrollPda,
            member: updateMemberPda,
            admin: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (err) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

});
