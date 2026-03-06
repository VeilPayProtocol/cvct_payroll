import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  awaitOperationComputation,
  createFixture,
  createHarness,
  expectRpcFailure,
  finalizeAndSettleDeposit,
  getDecryptedState,
  previewDepositShares,
  previewRedeemAssets,
  requestDeposit,
  requestRedeem,
  settleRedeemCall,
} from "./helpers/cvctHarness";
import {
  assertKaminoArtifactsPresent,
  assertKaminoProgramsLoaded,
  bootstrapKaminoVault,
  configureCvctKaminoAdapter,
  deriveKaminoPdas,
  KAMINO_KLEND_PROGRAM_ID,
  KAMINO_VAULT_PROGRAM_ID,
  kaminoDepositIdle,
  kaminoWithdrawToVault,
  shouldRunKaminoLocalTests,
  vaultBackedTokenAmount,
  vaultSharesTokenAmount,
} from "./helpers/kaminoLocal";

describe("Cvct Kamino Adapter", () => {
  const itLocalOnly = shouldRunKaminoLocalTests() ? it : it.skip;

  before(async () => {
    if (!shouldRunKaminoLocalTests()) {
      return;
    }

    assertKaminoArtifactsPresent();
    const harness = await createHarness(false);
    await assertKaminoProgramsLoaded(harness.connection);
  });

  it("configures kamino adapter state for a cvct mint", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);

    const vaultState = anchor.web3.Keypair.generate().publicKey;
    const pdas = deriveKaminoPdas(vaultState);
    const [kaminoAdapterPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("kamino_adapter"), fixture.cvctMintPda.toBuffer()],
      harness.program.programId,
    );

    await (harness.program.methods as any)
      .configureKaminoAdapter({
        kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
        klendProgram: KAMINO_KLEND_PROGRAM_ID,
        vaultState,
        globalConfig: pdas.globalConfig,
        baseVaultAuthority: pdas.baseVaultAuthority,
        tokenVault: pdas.tokenVault,
        sharesMint: pdas.sharesMint,
        eventAuthority: pdas.eventAuthority,
        enabled: true,
      })
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        kaminoAdapter: kaminoAdapterPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([fixture.authoritySigner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const adapter = await (harness.program.account as any).kaminoAdapterState.fetch(
      kaminoAdapterPda,
    );

    expect(adapter.enabled).to.eq(true);
    expect(adapter.cvctMint.toBase58()).to.eq(fixture.cvctMintPda.toBase58());
    expect(adapter.vaultState.toBase58()).to.eq(vaultState.toBase58());
  });

  it("rejects invalid kamino adapter PDA wiring during configuration", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);

    const vaultState = anchor.web3.Keypair.generate().publicKey;
    const pdas = deriveKaminoPdas(vaultState);
    const [kaminoAdapterPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("kamino_adapter"), fixture.cvctMintPda.toBuffer()],
      harness.program.programId,
    );

    await expectRpcFailure(
      (harness.program.methods as any)
        .configureKaminoAdapter({
          kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
          klendProgram: KAMINO_KLEND_PROGRAM_ID,
          vaultState,
          globalConfig: anchor.web3.Keypair.generate().publicKey,
          baseVaultAuthority: pdas.baseVaultAuthority,
          tokenVault: pdas.tokenVault,
          sharesMint: pdas.sharesMint,
          eventAuthority: pdas.eventAuthority,
          enabled: true,
        })
        .accountsPartial({
          authority: fixture.authoritySigner.publicKey,
          cvctMint: fixture.cvctMintPda,
          kaminoAdapter: kaminoAdapterPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([fixture.authoritySigner])
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
      "Invalid Kamino adapter configuration or account wiring",
    );
  });

  itLocalOnly("manually deposits idle vault assets into kamino and withdraws them back", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const beforeKaminoDeposit = await vaultBackedTokenAmount(fixture);
    await kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 300_000);
    const afterKaminoDeposit = await vaultBackedTokenAmount(fixture);
    const sharesAfterDeposit = await vaultSharesTokenAmount(
      kamino,
      harness.connection,
    );

    expect(afterKaminoDeposit).to.be.lessThan(beforeKaminoDeposit);
    expect(sharesAfterDeposit).to.be.greaterThan(0);

    await kaminoWithdrawToVault(
      fixture,
      kaminoAdapterPda,
      kamino,
      sharesAfterDeposit,
    );
    const afterKaminoWithdraw = await vaultBackedTokenAmount(fixture);

    expect(afterKaminoWithdraw).to.be.greaterThan(afterKaminoDeposit);
  });

  itLocalOnly("rejects treasury actions when the adapter is disabled", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    await (harness.program.methods as any)
      .configureKaminoAdapter({
        kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
        klendProgram: KAMINO_KLEND_PROGRAM_ID,
        vaultState: kamino.vaultState.publicKey,
        globalConfig: kamino.globalConfig,
        baseVaultAuthority: kamino.baseVaultAuthority,
        tokenVault: kamino.tokenVault,
        sharesMint: kamino.sharesMint,
        eventAuthority: kamino.eventAuthority,
        enabled: false,
      })
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        kaminoAdapter: kaminoAdapterPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([fixture.authoritySigner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    await expectRpcFailure(
      kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 100_000),
      "Kamino adapter is disabled",
    );
  });

  itLocalOnly("requires manual kamino withdraw before redeem settle when idle liquidity is low", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    await kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 400_000);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, redeemReq);
    const beforeState = await getDecryptedState(fixture);

    await expectRpcFailure(
      settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda),
      "Insufficient idle vault liquidity for redeem settlement",
    );
    const afterFailedSettle = await getDecryptedState(fixture);
    expect(afterFailedSettle.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterFailedSettle.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterFailedSettle.decryptedLocked).to.equal(beforeState.decryptedLocked);

    const sharesBalance = await vaultSharesTokenAmount(kamino, harness.connection);
    await kaminoWithdrawToVault(fixture, kaminoAdapterPda, kamino, sharesBalance);
    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);

    const state = await getDecryptedState(fixture);
    expect(state.decryptedSupply).to.equal(BigInt(fixture.depositAmount - fixture.burnAmount));
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount - fixture.burnAmount));
  });

  itLocalOnly("rejects kamino withdraw when global config wiring is wrong", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);
    await kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 250_000);

    const sharesBalance = await vaultSharesTokenAmount(kamino, harness.connection);

    await expectRpcFailure(
      (harness.program.methods as any)
        .kaminoWithdrawToVault(new anchor.BN(sharesBalance))
        .accountsPartial({
          authority: fixture.authoritySigner.publicKey,
          cvctMint: fixture.cvctMintPda,
          vault: fixture.vaultPda,
          kaminoAdapter: kaminoAdapterPda,
          vaultBackingTokenAccount: fixture.vaultTokenAccount,
          vaultSharesTokenAccount: kamino.vaultSharesTokenAccount,
          kaminoVaultState: kamino.vaultState.publicKey,
          kaminoGlobalConfig: anchor.web3.Keypair.generate().publicKey,
          kaminoTokenVault: kamino.tokenVault,
          kaminoTokenMint: fixture.backingMint,
          kaminoBaseVaultAuthority: kamino.baseVaultAuthority,
          kaminoSharesMint: kamino.sharesMint,
          kaminoEventAuthority: kamino.eventAuthority,
          kaminoProgram: KAMINO_VAULT_PROGRAM_ID,
          klendProgram: KAMINO_KLEND_PROGRAM_ID,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          sharesTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([fixture.authoritySigner])
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
      "Invalid Kamino adapter configuration or account wiring",
    );
  });

  itLocalOnly("allows adapter-aware asset sync after manual treasury movement", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    await kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 250_000);
    const vaultBefore = await harness.program.account.vault.fetch(fixture.vaultPda);
    await (harness.program.methods as any)
      .syncTotalAssetsFromAdapter(
        Array.from(vaultBefore.totalLocked[0]),
        vaultBefore.totalLockedNonce,
      )
      .accountsPartial({
        authority: fixture.authoritySigner.publicKey,
        cvctMint: fixture.cvctMintPda,
        vault: fixture.vaultPda,
        kaminoAdapter: kaminoAdapterPda,
      })
      .signers([fixture.authoritySigner])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    const state = await getDecryptedState(fixture);
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount));
  });
});
