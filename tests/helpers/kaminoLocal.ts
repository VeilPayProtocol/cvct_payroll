import * as anchor from "@coral-xyz/anchor";
import {
  createInitializeAccount3Instruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { existsSync } from "fs";
import path from "path";
import {
  Fixture,
  runLabeledRpc,
  sendAndConfirmHarnessTx,
  TEST_RPC_OPTIONS,
} from "./cvctHarness";

export const KAMINO_VAULT_PROGRAM_ID = new PublicKey(
  "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
);
export const KAMINO_KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);

export const KAMINO_BASE_VAULT_AUTHORITY_SEED = "authority";
export const KAMINO_TOKEN_VAULT_SEED = "token_vault";
export const KAMINO_SHARES_SEED = "shares";
export const KAMINO_EVENT_AUTHORITY_SEED = "__event_authority";
export const KAMINO_GLOBAL_CONFIG_STATE_SEED = "global_config";

export const KAMINO_VAULT_STATE_SIZE = 62_552;
const TOKEN_ACCOUNT_SIZE = 165;
const INIT_VAULT_DISCRIMINATOR = Buffer.from([77, 79, 85, 150, 33, 217, 52, 106]);

export function shouldRunKaminoLocalTests(): boolean {
  return process.env.CVCT_RUN_KAMINO_LOCAL === "1";
}

export type KaminoAdapterConfig = {
  kaminoProgram: PublicKey;
  klendProgram: PublicKey;
  vaultState: PublicKey;
  globalConfig: PublicKey;
  baseVaultAuthority: PublicKey;
  tokenVault: PublicKey;
  sharesMint: PublicKey;
  eventAuthority: PublicKey;
};

export type KaminoVaultContext = {
  vaultState: Keypair;
  baseVaultAuthority: PublicKey;
  tokenVault: PublicKey;
  sharesMint: PublicKey;
  eventAuthority: PublicKey;
  globalConfig: PublicKey;
  adminTokenAccount: PublicKey;
  vaultSharesTokenAccount: PublicKey;
};

export function kaminoArtifactPaths() {
  const baseDir = path.resolve(process.cwd(), "tests/fixtures/kamino");
  return {
    baseDir,
    kaminoVaultBinary: path.join(
      baseDir,
      "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.so",
    ),
    klendBinary: path.join(
      baseDir,
      "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.so",
    ),
    globalConfigAccount: path.join(baseDir, "accounts/global_config.json"),
  };
}

export function assertKaminoArtifactsPresent(): void {
  const paths = kaminoArtifactPaths();
  const missing = [
    paths.kaminoVaultBinary,
    paths.klendBinary,
    paths.globalConfigAccount,
  ].filter(
    (artifactPath) => !existsSync(artifactPath),
  );

  if (missing.length > 0) {
    throw new Error(
      [
        "Kamino local test artifacts are missing.",
        ...missing.map((artifactPath) => `Missing: ${artifactPath}`),
        "Fetch the Kamino Vault and KLend binaries from mainnet, place them in tests/fixtures/kamino, and start localnet with those programs preloaded before running CVCT_RUN_KAMINO_LOCAL=1 arcium test.",
      ].join("\n"),
    );
  }
}

export async function assertKaminoProgramsLoaded(
  connection: anchor.web3.Connection,
): Promise<void> {
  const kaminoProgram = await connection.getAccountInfo(
    KAMINO_VAULT_PROGRAM_ID,
    "confirmed",
  );
  const klendProgram = await connection.getAccountInfo(
    KAMINO_KLEND_PROGRAM_ID,
    "confirmed",
  );

  if (!kaminoProgram || !klendProgram) {
    throw new Error(
      [
        "Kamino programs are not loaded into the local validator.",
        `Expected Kamino Vault program: ${KAMINO_VAULT_PROGRAM_ID.toBase58()}`,
        `Expected KLend program: ${KAMINO_KLEND_PROGRAM_ID.toBase58()}`,
        "Load the repo-local binaries into localnet before running the Kamino adapter suite.",
      ].join("\n"),
    );
  }

  const globalConfig = deriveKaminoPdas(PublicKey.default).globalConfig;
  const globalConfigAccount = await connection.getAccountInfo(globalConfig, "confirmed");
  if (!globalConfigAccount) {
    throw new Error(
      [
        "Kamino global_config is not loaded into the local validator.",
        `Expected account: ${globalConfig.toBase58()}`,
        "Preload tests/fixtures/kamino/accounts/global_config.json via Anchor.toml before running the Kamino adapter suite.",
      ].join("\n"),
    );
  }

  if (!globalConfigAccount.owner.equals(KAMINO_VAULT_PROGRAM_ID)) {
    throw new Error(
      [
        "Kamino global_config is loaded with the wrong owner.",
        `Expected owner: ${KAMINO_VAULT_PROGRAM_ID.toBase58()}`,
        `Actual owner: ${globalConfigAccount.owner.toBase58()}`,
      ].join("\n"),
    );
  }
}

export function deriveKaminoPdas(vaultState: PublicKey): {
  baseVaultAuthority: PublicKey;
  tokenVault: PublicKey;
  sharesMint: PublicKey;
  eventAuthority: PublicKey;
  globalConfig: PublicKey;
} {
  const baseVaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from(KAMINO_BASE_VAULT_AUTHORITY_SEED), vaultState.toBuffer()],
    KAMINO_VAULT_PROGRAM_ID,
  )[0];
  const tokenVault = PublicKey.findProgramAddressSync(
    [Buffer.from(KAMINO_TOKEN_VAULT_SEED), vaultState.toBuffer()],
    KAMINO_VAULT_PROGRAM_ID,
  )[0];
  const sharesMint = PublicKey.findProgramAddressSync(
    [Buffer.from(KAMINO_SHARES_SEED), vaultState.toBuffer()],
    KAMINO_VAULT_PROGRAM_ID,
  )[0];
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from(KAMINO_EVENT_AUTHORITY_SEED)],
    KAMINO_VAULT_PROGRAM_ID,
  )[0];
  const globalConfig = PublicKey.findProgramAddressSync(
    [Buffer.from(KAMINO_GLOBAL_CONFIG_STATE_SEED)],
    KAMINO_VAULT_PROGRAM_ID,
  )[0];

  return {
    baseVaultAuthority,
    tokenVault,
    sharesMint,
    eventAuthority,
    globalConfig,
  };
}

function buildInitVaultInstruction(accounts: {
  adminAuthority: PublicKey;
  vaultState: PublicKey;
  baseVaultAuthority: PublicKey;
  tokenVault: PublicKey;
  baseTokenMint: PublicKey;
  sharesMint: PublicKey;
  adminTokenAccount: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: KAMINO_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: accounts.adminAuthority, isSigner: true, isWritable: true },
      { pubkey: accounts.vaultState, isSigner: false, isWritable: true },
      { pubkey: accounts.baseVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenVault, isSigner: false, isWritable: true },
      { pubkey: accounts.baseTokenMint, isSigner: false, isWritable: false },
      { pubkey: accounts.sharesMint, isSigner: false, isWritable: true },
      { pubkey: accounts.adminTokenAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: INIT_VAULT_DISCRIMINATOR,
  });
}

async function createVaultSharesTokenAccount(
  fixture: Fixture,
  sharesMint: PublicKey,
): Promise<PublicKey> {
  const rent = await fixture.harness.connection.getMinimumBalanceForRentExemption(
    TOKEN_ACCOUNT_SIZE,
  );
  const vaultSharesTokenAccount = Keypair.generate();
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: fixture.harness.payer.publicKey,
      newAccountPubkey: vaultSharesTokenAccount.publicKey,
      lamports: rent,
      space: TOKEN_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccount3Instruction(
      vaultSharesTokenAccount.publicKey,
      sharesMint,
      fixture.vaultPda,
      TOKEN_PROGRAM_ID,
    ),
  );

  await sendAndConfirmHarnessTx(
    fixture.harness,
    "createVaultSharesTokenAccount",
    tx,
    [vaultSharesTokenAccount],
  );
  return vaultSharesTokenAccount.publicKey;
}

export async function bootstrapKaminoVault(
  fixture: Fixture,
): Promise<KaminoVaultContext> {
  const { harness } = fixture;
  const adminTokenAccount = await getOrCreateAssociatedTokenAccount(
    harness.connection,
    harness.payer.payer,
    fixture.backingMint,
    fixture.authoritySigner.publicKey,
  );

  await mintTo(
    harness.connection,
    harness.payer.payer,
    fixture.backingMint,
    adminTokenAccount.address,
    harness.payer.payer,
    1_000_000,
  );

  const vaultState = Keypair.generate();
  const pdas = deriveKaminoPdas(vaultState.publicKey);
  const vaultStateRent =
    await harness.connection.getMinimumBalanceForRentExemption(
      KAMINO_VAULT_STATE_SIZE,
    );

  const setupTx = new anchor.web3.Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: harness.payer.publicKey,
      newAccountPubkey: vaultState.publicKey,
      lamports: vaultStateRent,
      space: KAMINO_VAULT_STATE_SIZE,
      programId: KAMINO_VAULT_PROGRAM_ID,
    }),
    buildInitVaultInstruction({
      adminAuthority: fixture.authoritySigner.publicKey,
      vaultState: vaultState.publicKey,
      baseVaultAuthority: pdas.baseVaultAuthority,
      tokenVault: pdas.tokenVault,
      baseTokenMint: fixture.backingMint,
      sharesMint: pdas.sharesMint,
      adminTokenAccount: adminTokenAccount.address,
    }),
  );

  await sendAndConfirmHarnessTx(harness, "bootstrapKaminoVault", setupTx, [
    fixture.authoritySigner,
    vaultState,
  ]);

  const vaultSharesTokenAccount = await createVaultSharesTokenAccount(
    fixture,
    pdas.sharesMint,
  );

  return {
    vaultState,
    baseVaultAuthority: pdas.baseVaultAuthority,
    tokenVault: pdas.tokenVault,
    sharesMint: pdas.sharesMint,
    eventAuthority: pdas.eventAuthority,
    globalConfig: pdas.globalConfig,
    adminTokenAccount: adminTokenAccount.address,
    vaultSharesTokenAccount,
  };
}

export async function configureCvctKaminoAdapter(
  fixture: Fixture,
  kamino: KaminoVaultContext,
): Promise<PublicKey> {
  const [kaminoAdapterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_adapter"), fixture.cvctMintPda.toBuffer()],
    fixture.harness.program.programId,
  );

  await runLabeledRpc(fixture.harness, "configureKaminoAdapter", () =>
    (fixture.harness.program.methods as any)
      .configureKaminoAdapter({
        kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
        klendProgram: KAMINO_KLEND_PROGRAM_ID,
        vaultState: kamino.vaultState.publicKey,
        globalConfig: kamino.globalConfig,
        baseVaultAuthority: kamino.baseVaultAuthority,
        tokenVault: kamino.tokenVault,
        sharesMint: kamino.sharesMint,
        eventAuthority: kamino.eventAuthority,
        enabled: true,
      })
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        kaminoAdapter: kaminoAdapterPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([fixture.authoritySigner])
      .rpc(TEST_RPC_OPTIONS),
  );

  return kaminoAdapterPda;
}

export async function kaminoDepositIdle(
  fixture: Fixture,
  kaminoAdapter: PublicKey,
  kamino: KaminoVaultContext,
  amount: number,
): Promise<void> {
  await runLabeledRpc(fixture.harness, "kaminoDepositIdle", () =>
    (fixture.harness.program.methods as any)
      .kaminoDepositIdle(new anchor.BN(amount))
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        kaminoAdapter,
        vaultBackingTokenAccount: fixture.vaultTokenAccount,
        vaultSharesTokenAccount: kamino.vaultSharesTokenAccount,
        kaminoVaultState: kamino.vaultState.publicKey,
        kaminoTokenVault: kamino.tokenVault,
        kaminoTokenMint: fixture.backingMint,
        kaminoBaseVaultAuthority: kamino.baseVaultAuthority,
        kaminoSharesMint: kamino.sharesMint,
        kaminoEventAuthority: kamino.eventAuthority,
        kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
        klendProgram: KAMINO_KLEND_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([fixture.authoritySigner])
      .rpc(TEST_RPC_OPTIONS),
  );
}

export async function kaminoWithdrawToVault(
  fixture: Fixture,
  kaminoAdapter: PublicKey,
  kamino: KaminoVaultContext,
  sharesAmount: number,
): Promise<void> {
  await runLabeledRpc(fixture.harness, "kaminoWithdrawToVault", () =>
    (fixture.harness.program.methods as any)
      .kaminoWithdrawToVault(new anchor.BN(sharesAmount))
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        kaminoAdapter,
        vaultBackingTokenAccount: fixture.vaultTokenAccount,
        vaultSharesTokenAccount: kamino.vaultSharesTokenAccount,
        kaminoVaultState: kamino.vaultState.publicKey,
        kaminoGlobalConfig: kamino.globalConfig,
        kaminoTokenVault: kamino.tokenVault,
        kaminoTokenMint: fixture.backingMint,
        kaminoBaseVaultAuthority: kamino.baseVaultAuthority,
        kaminoSharesMint: kamino.sharesMint,
        kaminoEventAuthority: kamino.eventAuthority,
        kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
        klendProgram: KAMINO_KLEND_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([fixture.authoritySigner])
      .rpc(TEST_RPC_OPTIONS),
  );
}

export async function vaultBackedTokenAmount(fixture: Fixture): Promise<number> {
  const account = await getAccount(
    fixture.harness.connection,
    fixture.vaultTokenAccount,
  );
  return Number(account.amount);
}

export async function vaultSharesTokenAmount(
  kamino: KaminoVaultContext,
  connection: anchor.web3.Connection,
): Promise<number> {
  const account = await getAccount(connection, kamino.vaultSharesTokenAccount);
  return Number(account.amount);
}
