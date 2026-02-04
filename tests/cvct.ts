import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  buildFinalizeCompDefTx,
  deserializeLE,
  getArciumAccountBaseSeed,
  getArciumEnv,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { Cvct } from "../target/types/cvct";

// Confidential circuit names compiled in encrypted-ixs.
const COMP_DEF_MINT = "init_mint_state";
const COMP_DEF_ACCOUNT = "init_account_state";
const COMP_DEF_DEPOSIT = "deposit_and_mint";

// Helper: produce a random 128-bit nonce as both bytes and BN.
function randomNonce(): { bytes: Uint8Array; bn: anchor.BN } {
  const bytes = randomBytes(16);
  return {
    bytes,
    bn: new anchor.BN(deserializeLE(bytes).toString()),
  };
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function decryptSharedU128(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  ownerSecretKey: Uint8Array,
  mxePublicKey: Uint8Array,
): bigint {
  const sharedSecret = x25519.getSharedSecret(ownerSecretKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  return cipher.decrypt([Array.from(ciphertext)], nonce)[0];
}

describe("Cvct", () => {
  // Explicit local RPC connection avoids env/provider issues under `arcium test`.
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  // Use local wallet keypair for signing.
  const wallet = anchor.Wallet.local();
  // Anchor provider with confirmed commitment for deterministic results.
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Cvct as Program<Cvct>;

  it("initializes cvct mint", async () => {
    const payer = provider.wallet as anchor.Wallet;

    // Give Arcium nodes a moment to finish booting before first RPC.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log("Initializing init_mint_state comp def");
    await initMintStateCompDef(program, payer);
    console.log("Comp def initialized");

    console.log("Initializing init_account_state comp def");
    await initAccountStateCompDef(program, payer);
    console.log("Account comp def initialized");

    console.log("Initializing deposit_and_mint comp def");
    await initDepositAndMintCompDef(program, payer);
    console.log("Deposit comp def initialized");

    // Backing SPL mint the CVCT mint will wrap.
    const backingMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6,
    );

    // CVCT mint PDA (one mint per authority).
    const [cvctMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cvct_mint"), payer.publicKey.toBuffer()],
      program.programId,
    );

    // Vault PDA holds the backing SPL tokens.
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), cvctMintPda.toBuffer()],
      program.programId,
    );

    // Vault ATA for the backing mint (owned by vault PDA).
    const vaultTokenAccount = await getAssociatedTokenAddress(
      backingMint,
      vaultPda,
      true,
    );

    // User ATA for the backing mint and initial funds for deposit.
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      backingMint,
      payer.publicKey,
    );
    await mintTo(
      provider.connection,
      payer.payer,
      backingMint,
      userTokenAccount.address,
      payer.payer,
      1_000_000,
    );

    // Arcium cluster offset and computation identifier.
    const arciumEnv = getArciumEnv();
    const computationOffset = new anchor.BN(randomBytes(8));

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId,
    );

    // Authority encryption inputs used to produce encrypted totals.
    const authorityKey = x25519.utils.randomSecretKey();
    const authorityPubkey = x25519.getPublicKey(authorityKey);
    const authorityNonce = randomNonce();
    const vaultNonce = randomNonce();

    // Arcium program + fee/clock PDAs used by queue_computation.
    const arciumProgramId = getArciumProgramId();
    const [poolAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("FeePool")],
      arciumProgramId,
    );
    const [clockAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("ClockAccount")],
      arciumProgramId,
    );

    // Comp def PDA is derived from the circuit name.
    const compDefOffset = getCompDefAccOffset(COMP_DEF_MINT);

    console.log("Queuing init_mint_state computation");
    await rpcWithLogs(
      program.methods
        .initializeCvctMint(
          computationOffset,
          Array.from(authorityPubkey),
          authorityNonce.bn,
          vaultNonce.bn,
        )
        .accountsPartial({
          authority: payer.publicKey,
          cvctMint: cvctMintPda,
          vault: vaultPda,
          backingMint,
          vaultTokenAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            computationOffset,
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(compDefOffset).readUInt32LE(),
          ),
          clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
          poolAccount,
          clockAccount,
          arciumProgram: arciumProgramId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
      "initializeCvctMint",
      provider.connection,
    );

    // Wait for Arcium to finalize and deliver the callback.
    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
    );

    // Initialize a CVCT account for the payer.
    const [cvctAccountPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("cvct_account"),
        cvctMintPda.toBuffer(),
        payer.publicKey.toBuffer(),
      ],
      program.programId,
    );

    const accountComputationOffset = new anchor.BN(randomBytes(8));
    const accountEncKey = x25519.utils.randomSecretKey();
    const accountEncPubkey = x25519.getPublicKey(accountEncKey);
    const accountNonce = randomNonce();

    const accountCompDefOffset = getCompDefAccOffset(COMP_DEF_ACCOUNT);

    console.log("Queuing init_account_state computation");
    await rpcWithLogs(
      program.methods
        .initializeCvctAccount(
          accountComputationOffset,
          Array.from(accountEncPubkey),
          accountNonce.bn,
        )
        .accountsPartial({
          owner: payer.publicKey,
          cvctAccount: cvctAccountPda,
          cvctMint: cvctMintPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            accountComputationOffset,
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(accountCompDefOffset).readUInt32LE(),
          ),
          clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
          poolAccount,
          clockAccount,
          arciumProgram: arciumProgramId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
      "initializeCvctAccount",
      provider.connection,
    );

    await awaitComputationFinalization(
      provider,
      accountComputationOffset,
      program.programId,
      "confirmed",
    );

    // Fetch updated state to get current nonces for deposit inputs.
    const cvctMintBefore = await program.account.cvctMint.fetch(cvctMintPda);
    const vaultBefore = await program.account.vault.fetch(vaultPda);
    const cvctAccountBefore = await program.account.cvctAccount.fetch(cvctAccountPda);

    const depositComputationOffset = new anchor.BN(randomBytes(8));
    const depositAmount = 500_000;
    const newBalanceNonce = randomNonce();
    const newSupplyNonce = randomNonce();
    const newLockedNonce = randomNonce();

    const depositCompDefOffset = getCompDefAccOffset(COMP_DEF_DEPOSIT);

    console.log("Queuing deposit_and_mint computation");
    await rpcWithLogs(
      program.methods
        .depositAndMint(
          depositComputationOffset,
          new anchor.BN(depositAmount),
          Array.from(accountEncPubkey),
          cvctAccountBefore.balanceNonce,
          newBalanceNonce.bn,
          Array.from(authorityPubkey),
          cvctMintBefore.totalSupplyNonce,
          newSupplyNonce.bn,
          Array.from(authorityPubkey),
          vaultBefore.totalLockedNonce,
          newLockedNonce.bn,
        )
        .accountsPartial({
          user: payer.publicKey,
          cvctMint: cvctMintPda,
          vault: vaultPda,
          cvctAccount: cvctAccountPda,
          userTokenAccount: userTokenAccount.address,
          vaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset,
          ),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            depositComputationOffset,
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(depositCompDefOffset).readUInt32LE(),
          ),
          clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
          poolAccount,
          clockAccount,
          arciumProgram: arciumProgramId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
      "depositAndMint",
      provider.connection,
    );

    await awaitComputationFinalization(
      provider,
      depositComputationOffset,
      program.programId,
      "confirmed",
    );

    // Fetch and print on-chain state after callback.
    const cvctMint = await program.account.cvctMint.fetch(cvctMintPda);
    const vault = await program.account.vault.fetch(vaultPda);
    const cvctAccount = await program.account.cvctAccount.fetch(cvctAccountPda);
    console.log("cvct_mint", cvctMint);
    console.log("vault", vault);
    console.log("cvct_account", cvctAccount);

    // Decrypt balances to confirm plaintext changes.
    const decryptedBalance = decryptSharedU128(
      Uint8Array.from(cvctAccount.balance[0]),
      Buffer.from(cvctAccount.balanceNonce.toArray("le", 16)),
      accountEncKey,
      mxePublicKey,
    );
    const decryptedSupply = decryptSharedU128(
      Uint8Array.from(cvctMint.totalSupply[0]),
      Buffer.from(cvctMint.totalSupplyNonce.toArray("le", 16)),
      authorityKey,
      mxePublicKey,
    );
    const decryptedLocked = decryptSharedU128(
      Uint8Array.from(vault.totalLocked[0]),
      Buffer.from(vault.totalLockedNonce.toArray("le", 16)),
      authorityKey,
      mxePublicKey,
    );

    console.log("decrypted_balance", decryptedBalance.toString());
    console.log("decrypted_total_supply", decryptedSupply.toString());
    console.log("decrypted_total_locked", decryptedLocked.toString());
  });
});

async function initMintStateCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  // Compute PDA for computation definition account.
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_MINT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  // Initialize comp def on-chain (required once per circuit).
  await rpcWithLogs(
    program.methods
      .initMintStateCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        arciumProgram: getArciumProgramId(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer.payer])
      .rpc({
        commitment: "confirmed",
      }),
    "initMintStateCompDef",
    program.provider.connection,
  );

  // Finalize comp def (registers compiled circuit).
  const finalizeTx = await buildFinalizeCompDefTx(
    program.provider as anchor.AnchorProvider,
    Buffer.from(offset).readUInt32LE(),
    program.programId,
  );

  // Retry blockhash fetch to handle early localnet startup.
  const latestBlockhash = await getLatestBlockhashWithRetry(
    program.provider.connection,
  );
  finalizeTx.recentBlockhash = latestBlockhash.blockhash;
  finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

  finalizeTx.sign(payer.payer);

  await rpcWithLogs(
    program.provider.sendAndConfirm(finalizeTx),
    "finalizeCompDef",
    program.provider.connection,
  );
}

async function initAccountStateCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_ACCOUNT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  await rpcWithLogs(
    program.methods
      .initAccountStateCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        arciumProgram: getArciumProgramId(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer.payer])
      .rpc({
        commitment: "confirmed",
      }),
    "initAccountStateCompDef",
    program.provider.connection,
  );

  const finalizeTx = await buildFinalizeCompDefTx(
    program.provider as anchor.AnchorProvider,
    Buffer.from(offset).readUInt32LE(),
    program.programId,
  );

  const latestBlockhash = await getLatestBlockhashWithRetry(
    program.provider.connection,
  );
  finalizeTx.recentBlockhash = latestBlockhash.blockhash;
  finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

  finalizeTx.sign(payer.payer);

  await rpcWithLogs(
    program.provider.sendAndConfirm(finalizeTx),
    "finalizeAccountCompDef",
    program.provider.connection,
  );
}

async function initDepositAndMintCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_DEPOSIT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  await rpcWithLogs(
    program.methods
      .initDepositAndMintCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        arciumProgram: getArciumProgramId(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer.payer])
      .rpc({
        commitment: "confirmed",
      }),
    "initDepositAndMintCompDef",
    program.provider.connection,
  );

  const finalizeTx = await buildFinalizeCompDefTx(
    program.provider as anchor.AnchorProvider,
    Buffer.from(offset).readUInt32LE(),
    program.programId,
  );

  const latestBlockhash = await getLatestBlockhashWithRetry(
    program.provider.connection,
  );
  finalizeTx.recentBlockhash = latestBlockhash.blockhash;
  finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

  finalizeTx.sign(payer.payer);

  await rpcWithLogs(
    program.provider.sendAndConfirm(finalizeTx),
    "finalizeDepositCompDef",
    program.provider.connection,
  );
}

// Simple retry for blockhash fetch (localnet may lag during boot).
async function getLatestBlockhashWithRetry(
  connection: anchor.web3.Connection,
  retries = 10,
  delayMs = 500,
) {
  for (let i = 0; i < retries; i++) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

// Helper to surface logs on transaction failure for faster debugging.
async function rpcWithLogs<T>(
  promise: Promise<T>,
  label: string,
  connection: anchor.web3.Connection,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const maybeLogs =
      (err as { logs?: string[] }).logs ||
      (err as { transactionError?: { logs?: string[] } }).transactionError
        ?.logs;
    if (maybeLogs) {
      console.error(`${label} logs:`, maybeLogs);
    } else if (
      err instanceof anchor.web3.SendTransactionError &&
      "getLogs" in (err as unknown as { getLogs?: unknown }) &&
      typeof (err as { getLogs?: (c: anchor.web3.Connection) => Promise<string[]> })
        .getLogs === "function"
    ) {
      const logs = await (err as unknown as {
        getLogs: (c: anchor.web3.Connection) => Promise<string[]>;
      }).getLogs(connection);
      console.error(`${label} logs:`, logs);
    }
    throw err;
  }
}
