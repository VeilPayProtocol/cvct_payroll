import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
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
import { expect } from "chai";
import { Cvct } from "../../target/types/cvct";

const COMP_DEF_MINT = "init_mint_state";
const COMP_DEF_ACCOUNT = "init_account_state";
const COMP_DEF_DEPOSIT = "deposit_and_mint";
const COMP_DEF_BURN = "burn_and_withdraw";
const COMP_DEF_TRANSFER = "transfer_cvct";

const VIRTUAL_ASSET_OFFSET = 1;
const VIRTUAL_SHARE_OFFSET = 1;

/**
 * Test harness conventions:
 * 1) Each test calls `createFixture` for fully isolated state.
 * 2) Keep one primary assertion per test name; prefer tags like
 *    `[math]`, `[init]`, `[deposit]`, `[redeem]`, `[transfer]`, `[invariant]`.
 * 3) Use flow helpers (`request*`, `finalizeAndSettle*`, `transferCvct`) instead of
 *    inlining account wiring in test files.
 * 4) Use assertion helpers for common guarantees:
 *    - `assertEarlySettleRejected`
 *    - `assertTerminalNoopOnResettle`
 *    - `assertEncryptedTotals`
 *    - `assertTokenBalances`
 * 5) Keep logs off by default; pass `createHarness(true)` only for local debugging.
 */
let compDefsInitialized = false;

export type Harness = {
  connection: anchor.web3.Connection;
  provider: anchor.AnchorProvider;
  wallet: anchor.Wallet;
  payer: anchor.Wallet;
  program: Program<Cvct>;
  arciumEnv: ReturnType<typeof getArciumEnv>;
  arciumProgramId: PublicKey;
  poolAccount: PublicKey;
  clockAccount: PublicKey;
  mxePublicKey: Uint8Array;
  debug: boolean;
};

export type Fixture = {
  harness: Harness;
  authoritySigner: anchor.web3.Keypair;
  backingMint: PublicKey;
  cvctMintPda: PublicKey;
  vaultPda: PublicKey;
  vaultTokenAccount: PublicKey;
  userTokenAccount: PublicKey;
  cvctAccountPda: PublicKey;
  recipientCvctAccountPda: PublicKey;
  authorityKey: Uint8Array;
  authorityPubkey: Uint8Array;
  accountEncKey: Uint8Array;
  accountEncPubkey: Uint8Array;
  recipientEncKey: Uint8Array;
  recipientEncPubkey: Uint8Array;
  depositAmount: number;
  burnAmount: number;
  transferAmount: number;
};

export type RequestResult = {
  operationPda: PublicKey;
  depositResultPda?: PublicKey;
  computationOffset: anchor.BN;
  deadlineSlot?: anchor.BN;
};

function randomNonce(): { bytes: Uint8Array; bn: anchor.BN } {
  const bytes = randomBytes(16);
  return {
    bytes,
    bn: new anchor.BN(deserializeLE(bytes).toString()),
  };
}

export function previewDepositShares(
  assetsIn: number,
  supply: number,
  assets: number,
): number {
  return Math.floor(
    (assetsIn * (supply + VIRTUAL_SHARE_OFFSET)) /
      (assets + VIRTUAL_ASSET_OFFSET),
  );
}

export function previewRedeemAssets(
  sharesIn: number,
  supply: number,
  assets: number,
): number {
  return Math.floor(
    (sharesIn * (assets + VIRTUAL_ASSET_OFFSET)) /
      (supply + VIRTUAL_SHARE_OFFSET),
  );
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
    } catch {
      // noop
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

export async function createHarness(debug = false): Promise<Harness> {
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Cvct as Program<Cvct>;

  const arciumEnv = getArciumEnv();
  const arciumProgramId = getArciumProgramId();
  const [poolAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("FeePool")],
    arciumProgramId,
  );
  const [clockAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("ClockAccount")],
    arciumProgramId,
  );

  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);

  return {
    connection,
    provider,
    wallet,
    payer: wallet,
    program,
    arciumEnv,
    arciumProgramId,
    poolAccount,
    clockAccount,
    mxePublicKey,
    debug,
  };
}

function log(harness: Harness, ...args: unknown[]) {
  if (harness.debug) {
    console.log(...args);
  }
}

export async function ensureCompDefs(harness: Harness): Promise<void> {
  if (compDefsInitialized) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await initMintStateCompDef(harness.program, harness.payer);
  await initAccountStateCompDef(harness.program, harness.payer);
  await initDepositAndMintCompDef(harness.program, harness.payer);
  await initBurnAndWithdrawCompDef(harness.program, harness.payer);
  await initTransferCvctCompDef(harness.program, harness.payer);
  compDefsInitialized = true;
}

export async function createFixture(harness: Harness): Promise<Fixture> {
  await ensureCompDefs(harness);

  const authoritySigner = anchor.web3.Keypair.generate();
  await transferLamports(
    harness.provider.connection,
    harness.payer.payer,
    authoritySigner.publicKey,
    anchor.web3.LAMPORTS_PER_SOL,
  );

  const backingMint = await createMint(
    harness.provider.connection,
    harness.payer.payer,
    harness.payer.publicKey,
    null,
    6,
  );

  const [cvctMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("cvct_mint"), authoritySigner.publicKey.toBuffer()],
    harness.program.programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), cvctMintPda.toBuffer()],
    harness.program.programId,
  );

  const vaultTokenAccount = await getAssociatedTokenAddress(
    backingMint,
    vaultPda,
    true,
  );

  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    harness.provider.connection,
    harness.payer.payer,
    backingMint,
    harness.payer.publicKey,
  );

  await mintTo(
    harness.provider.connection,
    harness.payer.payer,
    backingMint,
    userTokenAccount.address,
    harness.payer.payer,
    1_000_000,
  );

  const authorityKey = x25519.utils.randomSecretKey();
  const authorityPubkey = x25519.getPublicKey(authorityKey);
  const authorityNonce = randomNonce();
  const vaultNonce = randomNonce();

  const mintCompOffset = new anchor.BN(randomBytes(8));
  const mintCompDefOffset = getCompDefAccOffset(COMP_DEF_MINT);

  await rpcWithLogs(
    harness.program.methods
      .initializeCvctMint(
        mintCompOffset,
        Array.from(authorityPubkey),
        authorityNonce.bn,
        vaultNonce.bn,
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .accountsPartial({
        authority: authoritySigner.publicKey,
        cvctMint: cvctMintPda,
        vault: vaultPda,
        backingMint,
        vaultTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          mintCompOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(mintCompDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
      })
      .signers([authoritySigner])
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "initializeCvctMint",
    harness.provider.connection,
  );

  await awaitComputationFinalization(
    harness.provider,
    mintCompOffset,
    harness.program.programId,
    "confirmed",
  );

  const [cvctAccountPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("cvct_account"),
      cvctMintPda.toBuffer(),
      harness.payer.publicKey.toBuffer(),
    ],
    harness.program.programId,
  );

  const accountEncKey = x25519.utils.randomSecretKey();
  const accountEncPubkey = x25519.getPublicKey(accountEncKey);
  const accountNonce = randomNonce();
  const initOwnerCompOffset = new anchor.BN(randomBytes(8));
  const accountCompDefOffset = getCompDefAccOffset(COMP_DEF_ACCOUNT);

  await rpcWithLogs(
    harness.program.methods
      .initializeCvctAccount(
        initOwnerCompOffset,
        Array.from(accountEncPubkey),
        accountNonce.bn,
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ])
      .accountsPartial({
        owner: harness.payer.publicKey,
        cvctAccount: cvctAccountPda,
        cvctMint: cvctMintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          initOwnerCompOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(accountCompDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "initializeCvctAccountOwner",
    harness.provider.connection,
  );

  await awaitComputationFinalization(
    harness.provider,
    initOwnerCompOffset,
    harness.program.programId,
    "confirmed",
  );

  const recipient = anchor.web3.Keypair.generate();
  await transferLamports(
    harness.provider.connection,
    harness.payer.payer,
    recipient.publicKey,
    2 * anchor.web3.LAMPORTS_PER_SOL,
  );

  const [recipientCvctAccountPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("cvct_account"),
      cvctMintPda.toBuffer(),
      recipient.publicKey.toBuffer(),
    ],
    harness.program.programId,
  );

  const recipientEncKey = x25519.utils.randomSecretKey();
  const recipientEncPubkey = x25519.getPublicKey(recipientEncKey);
  const recipientNonce = randomNonce();
  const initRecipientCompOffset = new anchor.BN(randomBytes(8));

  await rpcWithLogs(
    harness.program.methods
      .initializeCvctAccount(
        initRecipientCompOffset,
        Array.from(recipientEncPubkey),
        recipientNonce.bn,
      )
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ])
      .accountsPartial({
        owner: recipient.publicKey,
        cvctAccount: recipientCvctAccountPda,
        cvctMint: cvctMintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          initRecipientCompOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(accountCompDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
      })
      .signers([recipient])
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "initializeCvctAccountRecipient",
    harness.provider.connection,
  );

  await awaitComputationFinalization(
    harness.provider,
    initRecipientCompOffset,
    harness.program.programId,
    "confirmed",
  );

  log(harness, "Fixture created", cvctMintPda.toBase58());

  return {
    harness,
    authoritySigner,
    backingMint,
    cvctMintPda,
    vaultPda,
    vaultTokenAccount,
    userTokenAccount: userTokenAccount.address,
    cvctAccountPda,
    recipientCvctAccountPda,
    authorityKey,
    authorityPubkey,
    accountEncKey,
    accountEncPubkey,
    recipientEncKey,
    recipientEncPubkey,
    depositAmount: 500_000,
    burnAmount: 200_000,
    transferAmount: 100_000,
  };
}

export async function requestDeposit(
  fixture: Fixture,
  assetsIn: number,
  minSharesOut: number,
  options?: { quotedSharesOut?: number; deadlineSlot?: anchor.BN },
): Promise<RequestResult> {
  const { harness } = fixture;
  const cvctMintBefore = await harness.program.account.cvctMint.fetch(
    fixture.cvctMintPda,
  );
  const vaultBefore = await harness.program.account.vault.fetch(fixture.vaultPda);
  const accountBefore = await harness.program.account.cvctAccount.fetch(
    fixture.cvctAccountPda,
  );

  const computationOffset = new anchor.BN(randomBytes(8));
  const operationId = new anchor.BN(randomBytes(8));
  const [operationPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pending_op"),
      fixture.cvctMintPda.toBuffer(),
      harness.payer.publicKey.toBuffer(),
      Buffer.from(operationId.toArray("le", 8)),
    ],
    harness.program.programId,
  );
  const [depositResultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pending_deposit_result"),
      fixture.cvctMintPda.toBuffer(),
      harness.payer.publicKey.toBuffer(),
      Buffer.from(operationId.toArray("le", 8)),
    ],
    harness.program.programId,
  );

  const newBalanceNonce = randomNonce();
  const newSupplyNonce = randomNonce();
  const newLockedNonce = randomNonce();
  const compDefOffset = getCompDefAccOffset(COMP_DEF_DEPOSIT);
  const quotedSharesOut = options?.quotedSharesOut ?? minSharesOut;
  const slot = await harness.connection.getSlot("confirmed");
  const deadlineSlot = options?.deadlineSlot ?? new anchor.BN(slot + 500);

  await rpcWithLogs(
    (harness.program.methods as any)
      .requestDepositIntent(
        computationOffset,
        operationId,
        new anchor.BN(assetsIn),
        new anchor.BN(minSharesOut),
        new anchor.BN(quotedSharesOut),
        deadlineSlot,
        Array.from(fixture.accountEncPubkey),
        accountBefore.balanceNonce,
        newBalanceNonce.bn,
        Array.from(fixture.authorityPubkey),
        cvctMintBefore.totalSupplyNonce,
        newSupplyNonce.bn,
        Array.from(fixture.authorityPubkey),
        vaultBefore.totalLockedNonce,
        newLockedNonce.bn,
      )
      .accountsPartial({
        user: harness.payer.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        cvctAccount: fixture.cvctAccountPda,
        userTokenAccount: fixture.userTokenAccount,
        vaultTokenAccount: fixture.vaultTokenAccount,
        pendingOperation: operationPda,
        pendingDepositResult: depositResultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          computationOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(compDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "requestDepositIntent",
    harness.provider.connection,
  );

  return { operationPda, depositResultPda, computationOffset, deadlineSlot };
}

export async function requestRedeem(
  fixture: Fixture,
  sharesIn: number,
  quotedAssetsOut: number,
): Promise<RequestResult> {
  const { harness } = fixture;
  const cvctMintBefore = await harness.program.account.cvctMint.fetch(
    fixture.cvctMintPda,
  );
  const vaultBefore = await harness.program.account.vault.fetch(fixture.vaultPda);
  const accountBefore = await harness.program.account.cvctAccount.fetch(
    fixture.cvctAccountPda,
  );

  const computationOffset = new anchor.BN(randomBytes(8));
  const operationId = new anchor.BN(randomBytes(8));
  const [operationPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pending_op"),
      fixture.cvctMintPda.toBuffer(),
      harness.payer.publicKey.toBuffer(),
      Buffer.from(operationId.toArray("le", 8)),
    ],
    harness.program.programId,
  );

  const newBalanceNonce = randomNonce();
  const newSupplyNonce = randomNonce();
  const newLockedNonce = randomNonce();
  const compDefOffset = getCompDefAccOffset(COMP_DEF_BURN);

  await rpcWithLogs(
    (harness.program.methods as any)
      .requestRedeem(
        computationOffset,
        operationId,
        new anchor.BN(sharesIn),
        new anchor.BN(quotedAssetsOut),
        Array.from(fixture.accountEncPubkey),
        accountBefore.balanceNonce,
        newBalanceNonce.bn,
        Array.from(fixture.authorityPubkey),
        cvctMintBefore.totalSupplyNonce,
        newSupplyNonce.bn,
        Array.from(fixture.authorityPubkey),
        vaultBefore.totalLockedNonce,
        newLockedNonce.bn,
      )
      .accountsPartial({
        user: harness.payer.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        cvctAccount: fixture.cvctAccountPda,
        userTokenAccount: fixture.userTokenAccount,
        vaultTokenAccount: fixture.vaultTokenAccount,
        pendingOperation: operationPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          computationOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(compDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "requestRedeem",
    harness.provider.connection,
  );

  return { operationPda, computationOffset };
}

export async function finalizeAndSettleDeposit(
  fixture: Fixture,
  req: RequestResult,
): Promise<void> {
  const { harness } = fixture;
  await awaitOperationComputation(fixture, req);

  await rpcWithLogs(
    (harness.program.methods as any)
      .settleDepositCommit()
      .accountsPartial({
        user: harness.payer.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        pendingOperation: req.operationPda,
        pendingDepositResult: req.depositResultPda,
        vaultTokenAccount: fixture.vaultTokenAccount,
        userTokenAccount: fixture.userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([harness.payer.payer])
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "settleDepositCommit",
    harness.provider.connection,
  );
}

export async function finalizeAndSettleRedeem(
  fixture: Fixture,
  req: RequestResult,
): Promise<void> {
  const { harness } = fixture;
  await awaitOperationComputation(fixture, req);

  await rpcWithLogs(
    (harness.program.methods as any)
      .settleRedeem()
      .accountsPartial({
        executor: harness.payer.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        pendingOperation: req.operationPda,
        vaultTokenAccount: fixture.vaultTokenAccount,
        userTokenAccount: fixture.userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "settleRedeem",
    harness.provider.connection,
  );
}

export async function awaitOperationComputation(
  fixture: Fixture,
  req: RequestResult,
): Promise<void> {
  await awaitComputationFinalization(
    fixture.harness.provider,
    req.computationOffset,
    fixture.harness.program.programId,
    "confirmed",
  );
}

export async function transferCvct(
  fixture: Fixture,
  amount: number,
): Promise<void> {
  const { harness } = fixture;
  const fromBefore = await harness.program.account.cvctAccount.fetch(
    fixture.cvctAccountPda,
  );
  const toBefore = await harness.program.account.cvctAccount.fetch(
    fixture.recipientCvctAccountPda,
  );

  const compOffset = new anchor.BN(randomBytes(8));
  const newFromNonce = randomNonce();
  const newToNonce = randomNonce();
  const compDefOffset = getCompDefAccOffset(COMP_DEF_TRANSFER);

  await rpcWithLogs(
    harness.program.methods
      .transferCvct(
        compOffset,
        new anchor.BN(amount),
        Array.from(fixture.accountEncPubkey),
        fromBefore.balanceNonce,
        newFromNonce.bn,
        Array.from(fixture.recipientEncPubkey),
        toBefore.balanceNonce,
        newToNonce.bn,
      )
      .accountsPartial({
        user: harness.payer.publicKey,
        fromCvctAccount: fixture.cvctAccountPda,
        toCvctAccount: fixture.recipientCvctAccountPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        mxeAccount: getMXEAccAddress(harness.program.programId),
        mempoolAccount: getMempoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(harness.arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(
          harness.arciumEnv.arciumClusterOffset,
          compOffset,
        ),
        compDefAccount: getCompDefAccAddress(
          harness.program.programId,
          Buffer.from(compDefOffset).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(harness.arciumEnv.arciumClusterOffset),
        poolAccount: harness.poolAccount,
        clockAccount: harness.clockAccount,
        arciumProgram: harness.arciumProgramId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "transferCvct",
    harness.provider.connection,
  );

  await awaitComputationFinalization(
    harness.provider,
    compOffset,
    harness.program.programId,
    "confirmed",
  );

  await waitForUpdatedBalances(
    harness.program,
    fixture.cvctAccountPda,
    fixture.recipientCvctAccountPda,
    newFromNonce.bn,
    newToNonce.bn,
  );
}

export async function getDecryptedState(fixture: Fixture) {
  const { harness } = fixture;
  const cvctMint = await harness.program.account.cvctMint.fetch(fixture.cvctMintPda);
  const vault = await harness.program.account.vault.fetch(fixture.vaultPda);
  const cvctAccount = await harness.program.account.cvctAccount.fetch(
    fixture.cvctAccountPda,
  );
  const recipientCvctAccount = await harness.program.account.cvctAccount.fetch(
    fixture.recipientCvctAccountPda,
  );

  const decryptedBalance = decryptSharedU128(
    Uint8Array.from(cvctAccount.balance[0]),
    Buffer.from(cvctAccount.balanceNonce.toArray("le", 16)),
    fixture.accountEncKey,
    harness.mxePublicKey,
  );
  const decryptedSupply = decryptSharedU128(
    Uint8Array.from(cvctMint.totalSupply[0]),
    Buffer.from(cvctMint.totalSupplyNonce.toArray("le", 16)),
    fixture.authorityKey,
    harness.mxePublicKey,
  );
  const decryptedLocked = decryptSharedU128(
    Uint8Array.from(vault.totalLocked[0]),
    Buffer.from(vault.totalLockedNonce.toArray("le", 16)),
    fixture.authorityKey,
    harness.mxePublicKey,
  );
  const decryptedRecipientBalance = decryptSharedU128(
    Uint8Array.from(recipientCvctAccount.balance[0]),
    Buffer.from(recipientCvctAccount.balanceNonce.toArray("le", 16)),
    fixture.recipientEncKey,
    harness.mxePublicKey,
  );

  return {
    decryptedBalance,
    decryptedSupply,
    decryptedLocked,
    decryptedRecipientBalance,
  };
}

export async function syncTotalAssetsNoop(fixture: Fixture): Promise<void> {
  const { harness } = fixture;
  const vault = await harness.program.account.vault.fetch(fixture.vaultPda);
  await rpcWithLogs(
    (harness.program.methods as any)
      .syncTotalAssets(Array.from(vault.totalLocked[0]), vault.totalLockedNonce)
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
      })
      .signers([fixture.authoritySigner])
      .rpc({ skipPreflight: true, commitment: "confirmed" }),
    "syncTotalAssets",
    harness.provider.connection,
  );
}

export async function fetchPendingStatus(
  fixture: Fixture,
  operationPda: PublicKey,
): Promise<number> {
  const op = await (fixture.harness.program.account as any).pendingOperation.fetch(
    operationPda,
  );
  return op.status;
}

export async function fetchPendingDepositResult(
  fixture: Fixture,
  resultPda: PublicKey,
): Promise<any> {
  return (fixture.harness.program.account as any).pendingDepositResult.fetch(resultPda);
}

export async function fetchUserBackingBalance(fixture: Fixture): Promise<number> {
  const user = await getAccount(
    fixture.harness.provider.connection,
    fixture.userTokenAccount,
  );
  return Number(user.amount);
}

export async function drainUserBackingTokens(
  fixture: Fixture,
  amount: number,
): Promise<void> {
  const destinationOwner = anchor.web3.Keypair.generate();
  const destination = await getOrCreateAssociatedTokenAccount(
    fixture.harness.connection,
    fixture.harness.payer.payer,
    fixture.backingMint,
    destinationOwner.publicKey,
  );

  await transfer(
    fixture.harness.connection,
    fixture.harness.payer.payer,
    fixture.userTokenAccount,
    destination.address,
    fixture.harness.payer.payer,
    amount,
  );
}

export async function assertEarlySettleRejected(
  settlePromise: Promise<unknown>,
): Promise<void> {
  await expectRpcFailure(settlePromise, "Operation has not been computed yet");
}

export async function assertTerminalNoopOnResettle(
  settlePromise: () => Promise<unknown>,
): Promise<void> {
  await settlePromise();
}

export function assertEncryptedTotals(
  actualSupply: bigint,
  actualLocked: bigint,
  expectedSupply: bigint,
  expectedLocked: bigint,
): void {
  expect(actualSupply).to.equal(expectedSupply);
  expect(actualLocked).to.equal(expectedLocked);
}

export async function assertTokenBalances(
  fixture: Fixture,
  expectedUserAmount: number,
  expectedVaultAmount: number,
): Promise<void> {
  const userAfter = await getAccount(
    fixture.harness.provider.connection,
    fixture.userTokenAccount,
  );
  const vaultAfter = await getAccount(
    fixture.harness.provider.connection,
    fixture.vaultTokenAccount,
  );

  expect(Number(userAfter.amount)).to.equal(expectedUserAmount);
  expect(Number(vaultAfter.amount)).to.equal(expectedVaultAmount);
}

export async function settleDepositCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey,
): Promise<unknown> {
  return (fixture.harness.program.methods as any)
    .settleDepositCommit()
    .accountsPartial({
      user: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      vault: fixture.vaultPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
      vaultTokenAccount: fixture.vaultTokenAccount,
      userTokenAccount: fixture.userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([fixture.harness.payer.payer])
    .rpc({ skipPreflight: true, commitment: "confirmed" });
}

export async function cancelDepositIntentCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey,
): Promise<unknown> {
  return (fixture.harness.program.methods as any)
    .cancelDepositIntent()
    .accountsPartial({
      user: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
    })
    .signers([fixture.harness.payer.payer])
    .rpc({ skipPreflight: true, commitment: "confirmed" });
}

export async function expireDepositIntentCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey,
): Promise<unknown> {
  return (fixture.harness.program.methods as any)
    .expireDepositIntent()
    .accountsPartial({
      executor: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
}

export async function settleRedeemCall(
  fixture: Fixture,
  operationPda: PublicKey,
): Promise<unknown> {
  return (fixture.harness.program.methods as any)
    .settleRedeem()
    .accountsPartial({
      executor: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      vault: fixture.vaultPda,
      pendingOperation: operationPda,
      vaultTokenAccount: fixture.vaultTokenAccount,
      userTokenAccount: fixture.userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
}

async function waitForUpdatedBalances(
  program: Program<Cvct>,
  fromAccount: PublicKey,
  toAccount: PublicKey,
  expectedFromNonce: anchor.BN,
  expectedToNonce: anchor.BN,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const from = await program.account.cvctAccount.fetch(fromAccount);
    const to = await program.account.cvctAccount.fetch(toAccount);
    if (
      from.balanceNonce.eq(expectedFromNonce) &&
      to.balanceNonce.eq(expectedToNonce)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function initMintStateCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_MINT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

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
      .rpc({ commitment: "confirmed" }),
    "initMintStateCompDef",
    program.provider.connection,
  );

  await finalizeCompDef(program, payer, offset, "finalizeCompDef");
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
      .rpc({ commitment: "confirmed" }),
    "initAccountStateCompDef",
    program.provider.connection,
  );

  await finalizeCompDef(program, payer, offset, "finalizeAccountCompDef");
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
      .rpc({ commitment: "confirmed" }),
    "initDepositAndMintCompDef",
    program.provider.connection,
  );

  await finalizeCompDef(program, payer, offset, "finalizeDepositCompDef");
}

async function initBurnAndWithdrawCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_BURN);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  await rpcWithLogs(
    program.methods
      .initBurnAndWithdrawCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        arciumProgram: getArciumProgramId(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer.payer])
      .rpc({ commitment: "confirmed" }),
    "initBurnAndWithdrawCompDef",
    program.provider.connection,
  );

  await finalizeCompDef(program, payer, offset, "finalizeBurnCompDef");
}

async function initTransferCvctCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount",
  );
  const offset = getCompDefAccOffset(COMP_DEF_TRANSFER);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  await rpcWithLogs(
    program.methods
      .initTransferCvctCompDef()
      .accountsPartial({
        compDefAccount: compDefPDA,
        payer: payer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        arciumProgram: getArciumProgramId(),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer.payer])
      .rpc({ commitment: "confirmed" }),
    "initTransferCvctCompDef",
    program.provider.connection,
  );

  await finalizeCompDef(program, payer, offset, "finalizeTransferCompDef");
}

async function finalizeCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
  offset: Uint8Array,
  label: string,
) {
  const finalizeTx = await buildFinalizeCompDefTx(
    program.provider as anchor.AnchorProvider,
    Buffer.from(offset).readUInt32LE(),
    program.programId,
  );

  const latestBlockhash = await getLatestBlockhashWithRetry(program.provider.connection);
  finalizeTx.recentBlockhash = latestBlockhash.blockhash;
  finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  finalizeTx.sign(payer.payer);

  await rpcWithLogs(
    program.provider.sendAndConfirm(finalizeTx),
    label,
    program.provider.connection,
  );
}

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

async function transferLamports(
  connection: anchor.web3.Connection,
  from: anchor.web3.Keypair,
  to: PublicKey,
  lamports: number,
): Promise<string> {
  const ix = anchor.web3.SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports,
  });

  const tx = new anchor.web3.Transaction().add(ix);
  tx.feePayer = from.publicKey;

  const latest = await getLatestBlockhashWithRetry(connection);
  tx.recentBlockhash = latest.blockhash;

  tx.sign(from);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  return sig;
}

async function rpcWithLogs<T>(
  promise: Promise<T>,
  label: string,
  connection: anchor.web3.Connection,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (process.env.CVCT_DEBUG_RPC_LOGS !== "1") {
      throw err;
    }
    const maybeLogs =
      (err as { logs?: string[] }).logs ||
      (err as { transactionError?: { logs?: string[] } }).transactionError?.logs;
    if (maybeLogs) {
      console.error(`${label} logs:`, maybeLogs);
    } else if (
      err instanceof anchor.web3.SendTransactionError &&
      "getLogs" in (err as unknown as { getLogs?: unknown }) &&
      typeof (err as { getLogs?: (c: anchor.web3.Connection) => Promise<string[]> }).getLogs ===
        "function"
    ) {
      const logs = await (err as unknown as {
        getLogs: (c: anchor.web3.Connection) => Promise<string[]>;
      }).getLogs(connection);
      console.error(`${label} logs:`, logs);
    }
    throw err;
  }
}

export async function expectRpcFailure(
  promise: Promise<unknown>,
  expectedMessageFragment: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected RPC failure but call succeeded");
  } catch (err) {
    const msg = String(err);
    expect(msg).to.contain(expectedMessageFragment);
  }
}
