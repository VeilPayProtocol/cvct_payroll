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
});
