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
 *    - `assertTerminalNoopOnResettle`
 *    - `assertEncryptedTotals`
 *    - `assertTokenBalances`
 * 5) Keep logs off by default; pass `createHarness(true)` only for local debugging.
 */
let compDefsInitialized = false;
let seededFastFixturePromise: Promise<Fixture> | null = null;
const timingEnabled = process.env.CVCT_DEBUG_TIMINGS === "1";
const TEST_COMMITMENT: anchor.web3.Commitment = "confirmed";
const TEST_CONFIRM_TIMEOUT_MS = 180_000;
export const TEST_RPC_OPTIONS = {
  skipPreflight: true,
  commitment: TEST_COMMITMENT,
} as const;
const TEST_SEND_OPTIONS = {
  skipPreflight: true,
  commitment: TEST_COMMITMENT,
  preflightCommitment: TEST_COMMITMENT,
} as const;

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
  pricingStatePda: PublicKey;
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
  redeemResultPda?: PublicKey;
  transferResultPda?: PublicKey;
  computationOffset: anchor.BN;
  deadlineSlot?: anchor.BN;
};

type TransferRequestOptions = {
  toCvctAccount?: PublicKey;
  toEncPubkey?: Uint8Array;
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
  assets: number
): number {
  return Math.floor(
    (assetsIn * (supply + VIRTUAL_SHARE_OFFSET)) /
      (assets + VIRTUAL_ASSET_OFFSET)
  );
}

export function previewRedeemAssets(
  sharesIn: number,
  supply: number,
  assets: number
): number {
  return Math.floor(
    (sharesIn * (assets + VIRTUAL_ASSET_OFFSET)) /
      (supply + VIRTUAL_SHARE_OFFSET)
  );
}

function decryptSharedU128(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  ownerSecretKey: Uint8Array,
  mxePublicKey: Uint8Array
): bigint {
  const sharedSecret = x25519.getSharedSecret(ownerSecretKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  return cipher.decrypt([Array.from(ciphertext)], nonce)[0];
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
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

  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

export async function createHarness(debug = false): Promise<Harness> {
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", {
    commitment: TEST_COMMITMENT,
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: TEST_CONFIRM_TIMEOUT_MS,
  });
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: TEST_COMMITMENT,
    preflightCommitment: TEST_COMMITMENT,
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Cvct as Program<Cvct>;

  const arciumEnv = getArciumEnv();
  const arciumProgramId = getArciumProgramId();
  const [poolAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("FeePool")],
    arciumProgramId
  );
  const [clockAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("ClockAccount")],
    arciumProgramId
  );

  const mxePublicKey = await getMXEPublicKeyWithRetry(
    provider,
    program.programId
  );

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

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    if (timingEnabled) {
      console.log(`[cvct-timing] ${label}: ${Date.now() - startedAt}ms`);
    }
  }
}

export async function ensureCompDefs(harness: Harness): Promise<void> {
  if (compDefsInitialized) {
    return;
  }
  await timed("ensureCompDefs", async () => {
    await initMintStateCompDef(harness.program, harness.payer);
    await initAccountStateCompDef(harness.program, harness.payer);
    await initDepositAndMintCompDef(harness.program, harness.payer);
    await initBurnAndWithdrawCompDef(harness.program, harness.payer);
    await initTransferCvctCompDef(harness.program, harness.payer);
  });
  compDefsInitialized = true;
}

export async function createFixture(harness: Harness): Promise<Fixture> {
  return timed("createFixture", async () => {
    await ensureCompDefs(harness);

    const authoritySigner = anchor.web3.Keypair.generate();
    await transferLamports(
      harness.provider.connection,
      harness.payer.payer,
      authoritySigner.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );

    const backingMint = await createMint(
      harness.provider.connection,
      harness.payer.payer,
      harness.payer.publicKey,
      null,
      6
    );

    const [cvctMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("cvct_mint"), authoritySigner.publicKey.toBuffer()],
      harness.program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), cvctMintPda.toBuffer()],
      harness.program.programId
    );
    const [pricingStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pricing_state"), cvctMintPda.toBuffer()],
      harness.program.programId
    );

    const vaultTokenAccount = await getAssociatedTokenAddress(
      backingMint,
      vaultPda,
      true
    );

    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      harness.provider.connection,
      harness.payer.payer,
      backingMint,
      harness.payer.publicKey
    );

    await mintTo(
      harness.provider.connection,
      harness.payer.payer,
      backingMint,
      userTokenAccount.address,
      harness.payer.payer,
      1_000_000
    );

    const authorityKey = x25519.utils.randomSecretKey();
    const authorityPubkey = x25519.getPublicKey(authorityKey);
    const authorityNonce = randomNonce();
    const vaultNonce = randomNonce();

    const mintCompOffset = new anchor.BN(randomBytes(8));
    const mintCompDefOffset = getCompDefAccOffset(COMP_DEF_MINT);

    await rpcWithLogs(
      (harness.program.methods as any)
        .initializeCvctMint(
          mintCompOffset,
          Array.from(authorityPubkey),
          authorityNonce.bn,
          vaultNonce.bn
        )
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .accountsPartial({
          authority: authoritySigner.publicKey,
          cvctMint: cvctMintPda,
          vault: vaultPda,
          pricingState: pricingStatePda,
          backingMint,
          vaultTokenAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          mxeAccount: getMXEAccAddress(harness.program.programId),
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount: getComputationAccAddress(
            harness.arciumEnv.arciumClusterOffset,
            mintCompOffset
          ),
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(mintCompDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
        })
        .signers([authoritySigner])
        .rpc(TEST_RPC_OPTIONS),
      "initializeCvctMint",
      harness.provider.connection
    );

    await awaitComputationFinalization(
      harness.provider,
      mintCompOffset,
      harness.program.programId,
      "confirmed"
    );

    const [cvctAccountPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("cvct_account"),
        cvctMintPda.toBuffer(),
        harness.payer.publicKey.toBuffer(),
      ],
      harness.program.programId
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
          accountNonce.bn
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
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount: getComputationAccAddress(
            harness.arciumEnv.arciumClusterOffset,
            initOwnerCompOffset
          ),
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(accountCompDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
        })
        .rpc(TEST_RPC_OPTIONS),
      "initializeCvctAccountOwner",
      harness.provider.connection
    );

    await awaitComputationFinalization(
      harness.provider,
      initOwnerCompOffset,
      harness.program.programId,
      "confirmed"
    );

    const recipient = anchor.web3.Keypair.generate();
    await transferLamports(
      harness.provider.connection,
      harness.payer.payer,
      recipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );

    const [recipientCvctAccountPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("cvct_account"),
        cvctMintPda.toBuffer(),
        recipient.publicKey.toBuffer(),
      ],
      harness.program.programId
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
          recipientNonce.bn
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
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount: getComputationAccAddress(
            harness.arciumEnv.arciumClusterOffset,
            initRecipientCompOffset
          ),
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(accountCompDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
        })
        .signers([recipient])
        .rpc(TEST_RPC_OPTIONS),
      "initializeCvctAccountRecipient",
      harness.provider.connection
    );

    await awaitComputationFinalization(
      harness.provider,
      initRecipientCompOffset,
      harness.program.programId,
      "confirmed"
    );

    log(harness, "Fixture created", cvctMintPda.toBase58());

    return {
      harness,
      authoritySigner,
      backingMint,
      cvctMintPda,
      pricingStatePda,
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
  });
}

export async function createSeededFastFixture(
  harness: Harness
): Promise<Fixture> {
  if (!seededFastFixturePromise) {
    seededFastFixturePromise = createFixture(harness);
  }
  return seededFastFixturePromise;
}

export async function requestDeposit(
  fixture: Fixture,
  assetsIn: number,
  minSharesOut: number,
  options?: { quotedSharesOut?: number; deadlineSlot?: anchor.BN }
): Promise<RequestResult> {
  return timed("requestDeposit", async () => {
    const { harness } = fixture;
    const cvctMintBefore = await harness.program.account.cvctMint.fetch(
      fixture.cvctMintPda
    );
    const vaultBefore = await harness.program.account.vault.fetch(
      fixture.vaultPda
    );
    const accountBefore = await harness.program.account.cvctAccount.fetch(
      fixture.cvctAccountPda
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
      harness.program.programId
    );
    const [depositResultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_deposit_result"),
        fixture.cvctMintPda.toBuffer(),
        harness.payer.publicKey.toBuffer(),
        Buffer.from(operationId.toArray("le", 8)),
      ],
      harness.program.programId
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
          newLockedNonce.bn
        )
        .accountsPartial({
          user: harness.payer.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          cvctAccount: fixture.cvctAccountPda,
          userTokenAccount: fixture.userTokenAccount,
          vaultTokenAccount: fixture.vaultTokenAccount,
          pendingOperation: operationPda,
          pendingDepositResult: depositResultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          mxeAccount: getMXEAccAddress(harness.program.programId),
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount: getComputationAccAddress(
            harness.arciumEnv.arciumClusterOffset,
            computationOffset
          ),
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(compDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(TEST_RPC_OPTIONS),
      "requestDepositIntent",
      harness.provider.connection
    );

    return { operationPda, depositResultPda, computationOffset, deadlineSlot };
  });
}

export async function requestRedeem(
  fixture: Fixture,
  sharesIn: number,
  quotedAssetsOut: number
): Promise<RequestResult> {
  return timed("requestRedeem", async () => {
    const { harness } = fixture;
    const cvctMintBefore = await harness.program.account.cvctMint.fetch(
      fixture.cvctMintPda
    );
    const vaultBefore = await harness.program.account.vault.fetch(
      fixture.vaultPda
    );
    const accountBefore = await harness.program.account.cvctAccount.fetch(
      fixture.cvctAccountPda
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
      harness.program.programId
    );
    const [redeemResultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_redeem_result"),
        fixture.cvctMintPda.toBuffer(),
        harness.payer.publicKey.toBuffer(),
        Buffer.from(operationId.toArray("le", 8)),
      ],
      harness.program.programId
    );

    const newBalanceNonce = randomNonce();
    const newSupplyNonce = randomNonce();
    const newLockedNonce = randomNonce();
    const compDefOffset = getCompDefAccOffset(COMP_DEF_BURN);

    await rpcWithLogs(
      (harness.program.methods as any)
        .requestRedeemIntent(
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
          newLockedNonce.bn
        )
        .accountsPartial({
          user: harness.payer.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          cvctAccount: fixture.cvctAccountPda,
          userTokenAccount: fixture.userTokenAccount,
          vaultTokenAccount: fixture.vaultTokenAccount,
          pendingOperation: operationPda,
          pendingRedeemResult: redeemResultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          mxeAccount: getMXEAccAddress(harness.program.programId),
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount: getComputationAccAddress(
            harness.arciumEnv.arciumClusterOffset,
            computationOffset
          ),
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(compDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc(TEST_RPC_OPTIONS),
      "requestRedeemIntent",
      harness.provider.connection
    );

    return { operationPda, redeemResultPda, computationOffset };
  });
}

export async function finalizeAndSettleDeposit(
  fixture: Fixture,
  req: RequestResult
): Promise<void> {
  await timed("finalizeAndSettleDeposit", async () => {
    const { harness } = fixture;
    await awaitOperationComputation(fixture, req);
    await waitForPendingDepositCallback(
      fixture,
      req.operationPda,
      req.depositResultPda!
    );

    await rpcWithLogs(
      (harness.program.methods as any)
        .settleDepositCommit()
        .accountsPartial({
          user: harness.payer.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          pendingOperation: req.operationPda,
          pendingDepositResult: req.depositResultPda,
          vaultTokenAccount: fixture.vaultTokenAccount,
          userTokenAccount: fixture.userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([harness.payer.payer])
        .rpc(TEST_RPC_OPTIONS),
      "settleDepositCommit",
      harness.provider.connection
    );
  });
}

export async function finalizeAndSettleRedeem(
  fixture: Fixture,
  req: RequestResult
): Promise<void> {
  await timed("finalizeAndSettleRedeem", async () => {
    const { harness } = fixture;
    await awaitOperationComputation(fixture, req);
    await waitForPendingRedeemCallback(
      fixture,
      req.operationPda,
      req.redeemResultPda!
    );

    await rpcWithLogs(
      (harness.program.methods as any)
        .settleRedeemCommit()
        .accountsPartial({
          executor: harness.payer.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          pendingOperation: req.operationPda,
          pendingRedeemResult: req.redeemResultPda,
          cvctAccount: fixture.cvctAccountPda,
          vaultTokenAccount: fixture.vaultTokenAccount,
          userTokenAccount: fixture.userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(TEST_RPC_OPTIONS),
      "settleRedeemCommit",
      harness.provider.connection
    );
  });
}

export async function awaitOperationComputation(
  fixture: Fixture,
  req: RequestResult
): Promise<void> {
  await awaitComputationFinalization(
    fixture.harness.provider,
    req.computationOffset,
    fixture.harness.program.programId,
    "confirmed"
  );
}

async function pollUntil<T>(
  fetcher: () => Promise<T>,
  ready: (value: T) => boolean,
  describe: (value: T) => string,
  label: string,
  intervalMs = 250,
  timeoutMs = 20_000
): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fetcher();
    if (ready(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastValue ? describe(lastValue) : "no state fetched";
  throw new Error(`${label} timed out after ${timeoutMs}ms: ${detail}`);
}

export async function waitForPendingDepositCallback(
  fixture: Fixture,
  operationPda: PublicKey,
  resultPda: PublicKey
): Promise<{ op: any; result: any }> {
  return pollUntil(
    async () => {
      const [op, result] = await Promise.all([
        (fixture.harness.program.account as any).pendingOperation.fetch(
          operationPda
        ),
        fetchPendingDepositResult(fixture, resultPda),
      ]);
      return { op, result };
    },
    ({ op, result }) => result.callbackApplied || isTerminalStatus(op.status),
    ({ op, result }) =>
      `operation=${operationPda.toBase58()} result=${resultPda.toBase58()} status=${
        op.status
      } callback_applied=${result.callbackApplied}`,
    "waitForPendingDepositCallback"
  );
}

export async function waitForPendingRedeemCallback(
  fixture: Fixture,
  operationPda: PublicKey,
  resultPda: PublicKey
): Promise<{ op: any; result: any }> {
  return pollUntil(
    async () => {
      const [op, result] = await Promise.all([
        (fixture.harness.program.account as any).pendingOperation.fetch(
          operationPda
        ),
        fetchPendingRedeemResult(fixture, resultPda),
      ]);
      return { op, result };
    },
    ({ op, result }) => result.callbackApplied || isTerminalStatus(op.status),
    ({ op, result }) =>
      `operation=${operationPda.toBase58()} result=${resultPda.toBase58()} status=${
        op.status
      } callback_applied=${result.callbackApplied}`,
    "waitForPendingRedeemCallback"
  );
}

export async function waitForPendingTransferCallback(
  fixture: Fixture,
  resultPda: PublicKey
): Promise<any> {
  return pollUntil(
    async () => fetchPendingTransferResult(fixture, resultPda),
    (result) => result.callbackApplied,
    (result) =>
      `result=${resultPda.toBase58()} callback_applied=${
        result.callbackApplied
      } ok=${result.ok}`,
    "waitForPendingTransferCallback"
  );
}

export async function requestTransferCvct(
  fixture: Fixture,
  amount: number,
  options?: TransferRequestOptions
): Promise<RequestResult> {
  return timed("requestTransferCvct", async () => {
    const { harness } = fixture;
    const toCvctAccount =
      options?.toCvctAccount ?? fixture.recipientCvctAccountPda;
    const toEncPubkey = options?.toEncPubkey ?? fixture.recipientEncPubkey;
    const fromBefore = await harness.program.account.cvctAccount.fetch(
      fixture.cvctAccountPda
    );
    const toBefore = await harness.program.account.cvctAccount.fetch(
      toCvctAccount
    );

    const compOffset = new anchor.BN(randomBytes(8));
    const computationAccount = getComputationAccAddress(
      harness.arciumEnv.arciumClusterOffset,
      compOffset
    );
    const [transferResultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_transfer_result"),
        fixture.cvctAccountPda.toBuffer(),
        toCvctAccount.toBuffer(),
        computationAccount.toBuffer(),
      ],
      harness.program.programId
    );
    const newFromNonce = randomNonce();
    const newToNonce = randomNonce();
    const compDefOffset = getCompDefAccOffset(COMP_DEF_TRANSFER);

    await rpcWithLogs(
      (harness.program.methods as any)
        .transferCvct(
          compOffset,
          new anchor.BN(amount),
          Array.from(fixture.accountEncPubkey),
          fromBefore.balanceNonce,
          newFromNonce.bn,
          Array.from(toEncPubkey),
          toBefore.balanceNonce,
          newToNonce.bn
        )
        .accountsPartial({
          user: harness.payer.publicKey,
          fromCvctAccount: fixture.cvctAccountPda,
          toCvctAccount,
          pendingTransferResult: transferResultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          mxeAccount: getMXEAccAddress(harness.program.programId),
          mempoolAccount: getMempoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          executingPool: getExecutingPoolAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          computationAccount,
          compDefAccount: getCompDefAccAddress(
            harness.program.programId,
            Buffer.from(compDefOffset).readUInt32LE()
          ),
          clusterAccount: getClusterAccAddress(
            harness.arciumEnv.arciumClusterOffset
          ),
          poolAccount: harness.poolAccount,
          clockAccount: harness.clockAccount,
          arciumProgram: harness.arciumProgramId,
        })
        .rpc(TEST_RPC_OPTIONS),
      "transferCvct",
      harness.provider.connection
    );

    return {
      operationPda: transferResultPda,
      transferResultPda,
      computationOffset: compOffset,
    };
  });
}

export async function transferCvct(
  fixture: Fixture,
  amount: number
): Promise<void> {
  const { harness } = fixture;
  const req = await requestTransferCvct(fixture, amount);
  await awaitComputationFinalization(
    harness.provider,
    req.computationOffset,
    harness.program.programId,
    "confirmed"
  );
  const transferResult = await waitForPendingTransferCallback(
    fixture,
    req.transferResultPda!
  );
  expect(transferResult.callbackApplied).to.equal(true);
  expect(transferResult.ok).to.equal(true);

  await waitForUpdatedBalances(
    harness.program,
    fixture.cvctAccountPda,
    fixture.recipientCvctAccountPda,
    transferResult.fromBalanceNonce,
    transferResult.toBalanceNonce
  );
}

export async function awaitTransferComputation(
  fixture: Fixture,
  req: RequestResult
): Promise<any> {
  return waitForPendingTransferCallback(fixture, req.transferResultPda!);
}

export async function failedTransferCvct(
  fixture: Fixture,
  amount: number
): Promise<any> {
  const { harness } = fixture;
  const req = await requestTransferCvct(fixture, amount);
  await awaitComputationFinalization(
    harness.provider,
    req.computationOffset,
    harness.program.programId,
    "confirmed"
  );
  const transferResult = await waitForPendingTransferCallback(
    fixture,
    req.transferResultPda!
  );
  expect(transferResult.callbackApplied).to.equal(true);
  expect(transferResult.ok).to.equal(false);
  return transferResult;
}

function isTerminalStatus(status: number): boolean {
  return status >= 3;
}

export async function getDecryptedState(fixture: Fixture) {
  const { harness } = fixture;
  const cvctMint = await harness.program.account.cvctMint.fetch(
    fixture.cvctMintPda
  );
  const vault = await harness.program.account.vault.fetch(fixture.vaultPda);
  const cvctAccount = await (harness.program.account as any).cvctAccount.fetch(
    fixture.cvctAccountPda
  );
  const recipientCvctAccount = await (
    harness.program.account as any
  ).cvctAccount.fetch(fixture.recipientCvctAccountPda);

  const decryptedBalance = decryptSharedU128(
    Uint8Array.from(cvctAccount.balance[0]),
    Buffer.from(cvctAccount.balanceNonce.toArray("le", 16)),
    fixture.accountEncKey,
    harness.mxePublicKey
  );
  const decryptedSupply = decryptSharedU128(
    Uint8Array.from(cvctMint.totalSupply[0]),
    Buffer.from(cvctMint.totalSupplyNonce.toArray("le", 16)),
    fixture.authorityKey,
    harness.mxePublicKey
  );
  const decryptedLocked = decryptSharedU128(
    Uint8Array.from(vault.totalLocked[0]),
    Buffer.from(vault.totalLockedNonce.toArray("le", 16)),
    fixture.authorityKey,
    harness.mxePublicKey
  );
  const decryptedRecipientBalance = decryptSharedU128(
    Uint8Array.from(recipientCvctAccount.balance[0]),
    Buffer.from(recipientCvctAccount.balanceNonce.toArray("le", 16)),
    fixture.recipientEncKey,
    harness.mxePublicKey
  );

  return {
    decryptedBalance,
    decryptedSupply,
    decryptedLocked,
    decryptedRecipientBalance,
    balanceVersion: Number(cvctAccount.balanceVersion),
    recipientBalanceVersion: Number(recipientCvctAccount.balanceVersion),
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
        pricingState: fixture.pricingStatePda,
        vault: fixture.vaultPda,
      })
      .signers([fixture.authoritySigner])
      .rpc(TEST_RPC_OPTIONS),
    "syncTotalAssets",
    harness.provider.connection
  );
}

export async function syncTotalAssetsChanged(fixture: Fixture): Promise<void> {
  const { harness } = fixture;
  const vault = await harness.program.account.vault.fetch(fixture.vaultPda);
  await rpcWithLogs(
    (harness.program.methods as any)
      .syncTotalAssets(
        Array.from(vault.totalLocked[0]),
        new anchor.BN(vault.totalLockedNonce.toString()).addn(1)
      )
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        pricingState: fixture.pricingStatePda,
        vault: fixture.vaultPda,
      })
      .signers([fixture.authoritySigner])
      .rpc(TEST_RPC_OPTIONS),
    "syncTotalAssetsChanged",
    harness.provider.connection
  );
}

export async function fetchPendingStatus(
  fixture: Fixture,
  operationPda: PublicKey
): Promise<number> {
  const op = await (
    fixture.harness.program.account as any
  ).pendingOperation.fetch(operationPda);
  return op.status;
}

export async function fetchPricingVersion(fixture: Fixture): Promise<number> {
  const pricingState = await (
    fixture.harness.program.account as any
  ).pricingState.fetch(fixture.pricingStatePda);
  return Number(pricingState.pricingVersion);
}

export async function fetchPendingDepositResult(
  fixture: Fixture,
  resultPda: PublicKey
): Promise<any> {
  return (fixture.harness.program.account as any).pendingDepositResult.fetch(
    resultPda
  );
}

export async function fetchPendingRedeemResult(
  fixture: Fixture,
  resultPda: PublicKey
): Promise<any> {
  return (fixture.harness.program.account as any).pendingRedeemResult.fetch(
    resultPda
  );
}

export async function fetchPendingTransferResult(
  fixture: Fixture,
  resultPda: PublicKey
): Promise<any> {
  return (fixture.harness.program.account as any).pendingTransferResult.fetch(
    resultPda
  );
}

export async function fetchUserBackingBalance(
  fixture: Fixture
): Promise<number> {
  const user = await getAccount(
    fixture.harness.provider.connection,
    fixture.userTokenAccount
  );
  return Number(user.amount);
}

export async function drainUserBackingTokens(
  fixture: Fixture,
  amount: number
): Promise<void> {
  const destinationOwner = anchor.web3.Keypair.generate();
  const destination = await getOrCreateAssociatedTokenAccount(
    fixture.harness.connection,
    fixture.harness.payer.payer,
    fixture.backingMint,
    destinationOwner.publicKey
  );

  await transfer(
    fixture.harness.connection,
    fixture.harness.payer.payer,
    fixture.userTokenAccount,
    destination.address,
    fixture.harness.payer.payer,
    amount
  );
}

export async function assertTerminalNoopOnResettle(
  settlePromise: () => Promise<unknown>
): Promise<void> {
  await settlePromise();
}

export function assertEncryptedTotals(
  actualSupply: bigint,
  actualLocked: bigint,
  expectedSupply: bigint,
  expectedLocked: bigint
): void {
  expect(actualSupply).to.equal(expectedSupply);
  expect(actualLocked).to.equal(expectedLocked);
}

export async function assertTokenBalances(
  fixture: Fixture,
  expectedUserAmount: number,
  expectedVaultAmount: number
): Promise<void> {
  const userAfter = await getAccount(
    fixture.harness.provider.connection,
    fixture.userTokenAccount
  );
  const vaultAfter = await getAccount(
    fixture.harness.provider.connection,
    fixture.vaultTokenAccount
  );

  expect(Number(userAfter.amount)).to.equal(expectedUserAmount);
  expect(Number(vaultAfter.amount)).to.equal(expectedVaultAmount);
}

export async function settleDepositCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey
): Promise<unknown> {
  return buildSettleDepositTx(fixture, operationPda, depositResultPda).rpc(
    TEST_RPC_OPTIONS
  );
}

function buildSettleDepositTx(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey
) {
  return (fixture.harness.program.methods as any)
    .settleDepositCommit()
    .accountsPartial({
      user: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pricingState: fixture.pricingStatePda,
      vault: fixture.vaultPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
      vaultTokenAccount: fixture.vaultTokenAccount,
      userTokenAccount: fixture.userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([fixture.harness.payer.payer]);
}

export async function cancelDepositIntentCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey
): Promise<unknown> {
  return buildCancelDepositIntentTx(
    fixture,
    operationPda,
    depositResultPda
  ).rpc(TEST_RPC_OPTIONS);
}

function buildCancelDepositIntentTx(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey
) {
  return (fixture.harness.program.methods as any)
    .cancelDepositIntent()
    .accountsPartial({
      user: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
    })
    .signers([fixture.harness.payer.payer]);
}

export async function expireDepositIntentCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda?: PublicKey
): Promise<unknown> {
  return (fixture.harness.program.methods as any)
    .expireDepositIntent()
    .accountsPartial({
      executor: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
    })
    .rpc(TEST_RPC_OPTIONS);
}

export async function settleRedeemCall(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda?: PublicKey
): Promise<unknown> {
  return buildSettleRedeemTx(fixture, operationPda, redeemResultPda).rpc(
    TEST_RPC_OPTIONS
  );
}

function buildSettleRedeemTx(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda?: PublicKey
) {
  return (fixture.harness.program.methods as any)
    .settleRedeemCommit()
    .accountsPartial({
      executor: fixture.harness.payer.publicKey,
      cvctMint: fixture.cvctMintPda,
      pricingState: fixture.pricingStatePda,
      vault: fixture.vaultPda,
      pendingOperation: operationPda,
      pendingRedeemResult: redeemResultPda,
      cvctAccount: fixture.cvctAccountPda,
      vaultTokenAccount: fixture.vaultTokenAccount,
      userTokenAccount: fixture.userTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
}

export async function cleanupTerminalDepositCall(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda: PublicKey,
  executor?: anchor.web3.Keypair
): Promise<unknown> {
  return buildCleanupTerminalDepositTx(
    fixture,
    operationPda,
    depositResultPda,
    executor
  ).rpc(TEST_RPC_OPTIONS);
}

function buildCleanupTerminalDepositTx(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda: PublicKey,
  executor?: anchor.web3.Keypair
) {
  const signer = executor ?? fixture.harness.payer.payer;
  return (fixture.harness.program.methods as any)
    .cleanupTerminalDeposit()
    .accountsPartial({
      executor: signer.publicKey,
      cvctMint: fixture.cvctMintPda,
      receiver: fixture.harness.payer.publicKey,
      pendingOperation: operationPda,
      pendingDepositResult: depositResultPda,
    })
    .signers([signer]);
}

export async function cleanupTerminalRedeemCall(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda: PublicKey,
  executor?: anchor.web3.Keypair
): Promise<unknown> {
  return buildCleanupTerminalRedeemTx(
    fixture,
    operationPda,
    redeemResultPda,
    executor
  ).rpc(TEST_RPC_OPTIONS);
}

function buildCleanupTerminalRedeemTx(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda: PublicKey,
  executor?: anchor.web3.Keypair
) {
  const signer = executor ?? fixture.harness.payer.payer;
  return (fixture.harness.program.methods as any)
    .cleanupTerminalRedeem()
    .accountsPartial({
      executor: signer.publicKey,
      cvctMint: fixture.cvctMintPda,
      receiver: fixture.harness.payer.publicKey,
      pendingOperation: operationPda,
      pendingRedeemResult: redeemResultPda,
    })
    .signers([signer]);
}

export async function cleanupTransferResultCall(
  fixture: Fixture,
  transferResultPda: PublicKey,
  executor?: anchor.web3.Keypair
): Promise<unknown> {
  const signer = executor ?? fixture.harness.payer.payer;
  return (fixture.harness.program.methods as any)
    .cleanupTransferResult()
    .accountsPartial({
      executor: signer.publicKey,
      receiver: fixture.harness.payer.publicKey,
      fromCvctAccount: fixture.cvctAccountPda,
      pendingTransferResult: transferResultPda,
    })
    .signers([signer])
    .rpc(TEST_RPC_OPTIONS);
}

export async function advancePastSlot(
  fixture: Fixture,
  targetSlot: number,
  maxAttempts = 40
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentSlot = await fixture.harness.connection.getSlot("confirmed");
    if (currentSlot > targetSlot) {
      return currentSlot;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const refreshedSlot = await fixture.harness.connection.getSlot("confirmed");
    if (refreshedSlot > targetSlot) {
      return refreshedSlot;
    }

    await transferLamports(
      fixture.harness.connection,
      fixture.harness.payer.payer,
      fixture.authoritySigner.publicKey,
      1
    );
  }

  const finalSlot = await fixture.harness.connection.getSlot("confirmed");
  throw new Error(
    `advancePastSlot timed out: target=${targetSlot} final=${finalSlot} attempts=${maxAttempts}`
  );
}

export async function createCleanupExecutor(
  fixture: Fixture,
  lamports = anchor.web3.LAMPORTS_PER_SOL / 10
): Promise<anchor.web3.Keypair> {
  const executor = anchor.web3.Keypair.generate();
  await transferLamports(
    fixture.harness.connection,
    fixture.harness.payer.payer,
    executor.publicKey,
    lamports
  );
  return executor;
}

async function expectMethodSimFailure(
  label: string,
  simulateCall: () => Promise<unknown>,
  expectedMessageFragment: string
): Promise<void> {
  try {
    await simulateCall();
    throw new Error(
      `Expected simulation failure for ${label} but call succeeded`
    );
  } catch (err: any) {
    const msg = [
      label,
      err?.message ?? String(err),
      err?.logs ? err.logs.join(" ") : "",
      err?.simulationResponse?.logs
        ? err.simulationResponse.logs.join(" ")
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    expect(msg).to.contain(expectedMessageFragment);
  }
}

export async function expectSettleDepositRejectedSim(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda: PublicKey | undefined,
  expectedMessageFragment: string
): Promise<void> {
  await expectMethodSimFailure(
    "settleDepositCommit",
    () =>
      buildSettleDepositTx(fixture, operationPda, depositResultPda).simulate(
        TEST_RPC_OPTIONS
      ),
    expectedMessageFragment
  );
}

export async function expectCancelDepositRejectedSim(
  fixture: Fixture,
  operationPda: PublicKey,
  depositResultPda: PublicKey | undefined,
  expectedMessageFragment: string
): Promise<void> {
  await expectMethodSimFailure(
    "cancelDepositIntent",
    () =>
      buildCancelDepositIntentTx(
        fixture,
        operationPda,
        depositResultPda
      ).simulate(TEST_RPC_OPTIONS),
    expectedMessageFragment
  );
}

export async function expectSettleRedeemRejectedSim(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda: PublicKey | undefined,
  expectedMessageFragment: string
): Promise<void> {
  await expectMethodSimFailure(
    "settleRedeemCommit",
    () =>
      buildSettleRedeemTx(fixture, operationPda, redeemResultPda).simulate(
        TEST_RPC_OPTIONS
      ),
    expectedMessageFragment
  );
}

export async function expectRedeemCleanupRejectedSim(
  fixture: Fixture,
  operationPda: PublicKey,
  redeemResultPda: PublicKey,
  expectedMessageFragment: string
): Promise<void> {
  await expectMethodSimFailure(
    "cleanupTerminalRedeem",
    () =>
      buildCleanupTerminalRedeemTx(
        fixture,
        operationPda,
        redeemResultPda
      ).simulate(TEST_RPC_OPTIONS),
    expectedMessageFragment
  );
}

export async function accountExists(
  fixture: Fixture,
  pubkey: PublicKey
): Promise<boolean> {
  return (
    (await fixture.harness.connection.getAccountInfo(pubkey, "confirmed")) !==
    null
  );
}

async function waitForUpdatedBalances(
  program: Program<Cvct>,
  fromAccount: PublicKey,
  toAccount: PublicKey,
  expectedFromNonce: anchor.BN,
  expectedToNonce: anchor.BN
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
  payer: anchor.Wallet
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset(COMP_DEF_MINT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId()
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
      .rpc({ commitment: TEST_COMMITMENT }),
    "initMintStateCompDef",
    program.provider.connection
  );

  await finalizeCompDef(program, payer, offset, "finalizeCompDef");
}

async function initAccountStateCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset(COMP_DEF_ACCOUNT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId()
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
      .rpc({ commitment: TEST_COMMITMENT }),
    "initAccountStateCompDef",
    program.provider.connection
  );

  await finalizeCompDef(program, payer, offset, "finalizeAccountCompDef");
}

async function initDepositAndMintCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset(COMP_DEF_DEPOSIT);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId()
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
      .rpc({ commitment: TEST_COMMITMENT }),
    "initDepositAndMintCompDef",
    program.provider.connection
  );

  await finalizeCompDef(program, payer, offset, "finalizeDepositCompDef");
}

async function initBurnAndWithdrawCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset(COMP_DEF_BURN);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId()
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
      .rpc({ commitment: TEST_COMMITMENT }),
    "initBurnAndWithdrawCompDef",
    program.provider.connection
  );

  await finalizeCompDef(program, payer, offset, "finalizeBurnCompDef");
}

async function initTransferCvctCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet
): Promise<void> {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset(COMP_DEF_TRANSFER);

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgramId()
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
      .rpc({ commitment: TEST_COMMITMENT }),
    "initTransferCvctCompDef",
    program.provider.connection
  );

  await finalizeCompDef(program, payer, offset, "finalizeTransferCompDef");
}

async function finalizeCompDef(
  program: Program<Cvct>,
  payer: anchor.Wallet,
  offset: Uint8Array,
  label: string
) {
  const finalizeTx = await buildFinalizeCompDefTx(
    program.provider as anchor.AnchorProvider,
    Buffer.from(offset).readUInt32LE(),
    program.programId
  );

  const latestBlockhash = await getLatestBlockhashWithRetry(
    program.provider.connection
  );
  finalizeTx.recentBlockhash = latestBlockhash.blockhash;
  finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  finalizeTx.sign(payer.payer);

  await rpcWithLogs(
    program.provider.sendAndConfirm(finalizeTx, [], TEST_SEND_OPTIONS),
    label,
    program.provider.connection
  );
}

async function getLatestBlockhashWithRetry(
  connection: anchor.web3.Connection,
  retries = 10,
  delayMs = 500
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
  lamports: number
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
    "confirmed"
  );

  return sig;
}

async function rpcWithLogs<T>(
  promise: Promise<T>,
  label: string,
  connection: anchor.web3.Connection
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (process.env.CVCT_DEBUG_RPC_LOGS !== "1") {
      throw err;
    }
    const maybeLogs =
      (err as { logs?: string[] }).logs ||
      (err as { transactionError?: { logs?: string[] } }).transactionError
        ?.logs;
    if (maybeLogs) {
      console.error(`${label} logs:`, maybeLogs);
    } else if (
      err instanceof anchor.web3.SendTransactionError &&
      "getLogs" in (err as unknown as { getLogs?: unknown }) &&
      typeof (
        err as { getLogs?: (c: anchor.web3.Connection) => Promise<string[]> }
      ).getLogs === "function"
    ) {
      const logs = await (
        err as unknown as {
          getLogs: (c: anchor.web3.Connection) => Promise<string[]>;
        }
      ).getLogs(connection);
      console.error(`${label} logs:`, logs);
    }
    if (err instanceof Error && err.name === "TransactionExpiredTimeoutError") {
      const signatureMatch = err.message.match(
        /signature\s+([1-9A-HJ-NP-Za-km-z]+)/
      );
      const signature = signatureMatch?.[1];
      const timeoutError = new Error(
        [
          `${label} confirmation timed out after ${TEST_CONFIRM_TIMEOUT_MS}ms.`,
          signature ? `Signature: ${signature}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      );
      (timeoutError as Error & { cause?: unknown }).cause = err;
      throw timeoutError;
    }
    throw err;
  }
}

export async function runLabeledRpc<T>(
  harness: Harness,
  label: string,
  rpcCall: () => Promise<T>
): Promise<T> {
  return timed(`rpc:${label}`, async () =>
    rpcWithLogs(rpcCall(), label, harness.connection)
  );
}

export async function sendAndConfirmHarnessTx(
  harness: Harness,
  label: string,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = []
): Promise<string> {
  return timed(`tx:${label}`, async () =>
    rpcWithLogs(
      harness.provider.sendAndConfirm(tx, signers, TEST_SEND_OPTIONS),
      label,
      harness.connection
    )
  );
}

export async function expectRpcFailure(
  promise: Promise<unknown>,
  expectedMessageFragment: string
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected RPC failure but call succeeded");
  } catch (err) {
    const msg = String(err);
    expect(msg).to.contain(expectedMessageFragment);
  }
}
