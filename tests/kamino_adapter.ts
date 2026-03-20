import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  awaitOperationComputation,
  finalizeAndSettleDeposit,
  requestDeposit,
  requestRedeem,
  settleRedeemCall,
} from "./helpers/cvctFlows";
import {
  createFixture,
  createHarness,
  previewDepositShares,
  previewRedeemAssets,
  runLabeledRpc,
  TEST_RPC_OPTIONS,
} from "./helpers/cvctEnv";
import {
  getDecryptedState,
  expectRpcFailure,
  fetchPendingStatus,
  fetchPricingVersion,
} from "./helpers/cvctAssertions";
import {
  assertKaminoArtifactsPresent,
  assertKaminoProgramsLoaded,
  bootstrapKaminoVault,
  configureCvctKaminoAdapter,
  deriveKaminoPdas,
  KAMINO_KLEND_PROGRAM_ID,
  KAMINO_VAULT_PROGRAM_ID,
  kaminoDepositIdle,
  kaminoRedeemRemainingAccounts,
  kaminoWithdrawToVault,
  rebalanceIdleLiquidity,
  shouldRunKaminoLocalTests,
  updateKaminoPolicy,
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

    await runLabeledRpc(harness, "configureKaminoAdapter", () =>
      (harness.program.methods as any)
        .configureKaminoAdapter({
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
        .rpc(TEST_RPC_OPTIONS),
    );

    const adapter = await (harness.program.account as any).kaminoAdapterState.fetch(
      kaminoAdapterPda,
    );

    expect(adapter.enabled).to.eq(true);
    expect(adapter.cvctMint.toBase58()).to.eq(fixture.cvctMintPda.toBase58());
    expect(adapter.vaultState.toBase58()).to.eq(vaultState.toBase58());
    expect(adapter.idleLiquidityThresholdBps).to.eq(0);
    expect(adapter.redeemWithdrawBufferAmount.toNumber()).to.eq(0);
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
        .rpc(TEST_RPC_OPTIONS),
      "Invalid Kamino adapter configuration or account wiring",
    );
  });

  itLocalOnly("rejects invalid kamino threshold values", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    await expectRpcFailure(
      updateKaminoPolicy(fixture, kaminoAdapterPda, 10_001),
      "Invalid Kamino policy configuration",
    );
  });

  itLocalOnly("rebalances excess idle vault assets into kamino from the configured threshold", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);
    await updateKaminoPolicy(fixture, kaminoAdapterPda, 2_000, 0);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const beforeKaminoDeposit = await vaultBackedTokenAmount(fixture);
    await rebalanceIdleLiquidity(fixture, kaminoAdapterPda, kamino);
    const afterKaminoDeposit = await vaultBackedTokenAmount(fixture);
    const sharesAfterDeposit = await vaultSharesTokenAmount(
      kamino,
      harness.connection,
    );

    expect(afterKaminoDeposit).to.equal(100_000);
    expect(beforeKaminoDeposit - afterKaminoDeposit).to.equal(400_000);
    expect(sharesAfterDeposit).to.be.greaterThan(0);
  });

  itLocalOnly("rejects treasury actions when the adapter is disabled", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    await runLabeledRpc(harness, "disableKaminoAdapter", () =>
      (harness.program.methods as any)
        .configureKaminoAdapter({
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
        .rpc(TEST_RPC_OPTIONS),
    );

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    await expectRpcFailure(
      kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 100_000),
      "Kamino adapter is disabled",
    );
    await expectRpcFailure(
      rebalanceIdleLiquidity(fixture, kaminoAdapterPda, kamino),
      "Kamino adapter is disabled",
    );
  });

  itLocalOnly("auto-withdraws from kamino during redeem settle when idle liquidity is low", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);
    await updateKaminoPolicy(fixture, kaminoAdapterPda, 0, 75_000);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    await kaminoDepositIdle(fixture, kaminoAdapterPda, kamino, 400_000);
    const sharesBeforeSettle = await vaultSharesTokenAmount(kamino, harness.connection);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, redeemReq);
    const beforeState = await getDecryptedState(fixture);
    const idleBeforeSettle = await vaultBackedTokenAmount(fixture);

    await settleRedeemCall(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda,
      kaminoRedeemRemainingAccounts(kaminoAdapterPda, fixture, kamino),
    );
    const idleAfterSettle = await vaultBackedTokenAmount(fixture);
    const sharesAfterSettle = await vaultSharesTokenAmount(kamino, harness.connection);
    expect(idleAfterSettle).to.be.greaterThan(0);
    expect(idleAfterSettle).to.be.lessThan(idleBeforeSettle);
    expect(idleAfterSettle).to.be.closeTo(75_000, 2_000);
    expect(sharesAfterSettle).to.be.greaterThan(0);
    expect(sharesAfterSettle).to.be.lessThan(sharesBeforeSettle);

    const state = await getDecryptedState(fixture);
    expect(beforeState.decryptedBalance).to.equal(BigInt(fixture.depositAmount));
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
        .rpc(TEST_RPC_OPTIONS),
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
    await runLabeledRpc(harness, "syncTotalAssetsFromAdapter", () =>
      (harness.program.methods as any)
        .syncTotalAssetsFromAdapter(
          Array.from(vaultBefore.totalLocked[0]),
          vaultBefore.totalLockedNonce,
        )
        .accountsPartial({
          authority: fixture.authoritySigner.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          kaminoAdapter: kaminoAdapterPda,
        })
        .signers([fixture.authoritySigner])
        .rpc(TEST_RPC_OPTIONS),
    );

    const state = await getDecryptedState(fixture);
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount));
  });

  itLocalOnly("no-op adapter sync preserves staged redeem settleability", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, redeemReq);

    const versionBeforeSync = await fetchPricingVersion(fixture);
    const vaultBefore = await harness.program.account.vault.fetch(fixture.vaultPda);
    await runLabeledRpc(harness, "syncTotalAssetsFromAdapterNoop", () =>
      (harness.program.methods as any)
        .syncTotalAssetsFromAdapter(
          Array.from(vaultBefore.totalLocked[0]),
          vaultBefore.totalLockedNonce,
        )
        .accountsPartial({
          authority: fixture.authoritySigner.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          kaminoAdapter: kaminoAdapterPda,
        })
        .signers([fixture.authoritySigner])
        .rpc(TEST_RPC_OPTIONS),
    );

    expect(await fetchPricingVersion(fixture)).to.equal(versionBeforeSync);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(1);

    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(3);
  });

  itLocalOnly("changed adapter sync still invalidates staged redeem", async () => {
    const harness = await createHarness(false);
    const fixture = await createFixture(harness);
    const kamino = await bootstrapKaminoVault(fixture);
    const kaminoAdapterPda = await configureCvctKaminoAdapter(fixture, kamino);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, redeemReq);

    const versionBeforeSync = await fetchPricingVersion(fixture);
    const vaultBefore = await harness.program.account.vault.fetch(fixture.vaultPda);
    await runLabeledRpc(harness, "syncTotalAssetsFromAdapterChanged", () =>
      (harness.program.methods as any)
        .syncTotalAssetsFromAdapter(
          Array.from(vaultBefore.totalLocked[0]),
          new anchor.BN(vaultBefore.totalLockedNonce.toString()).addn(1),
        )
        .accountsPartial({
          authority: fixture.authoritySigner.publicKey,
          cvctMint: fixture.cvctMintPda,
          pricingState: fixture.pricingStatePda,
          vault: fixture.vaultPda,
          kaminoAdapter: kaminoAdapterPda,
        })
        .signers([fixture.authoritySigner])
        .rpc(TEST_RPC_OPTIONS),
    );

    expect(await fetchPricingVersion(fixture)).to.equal(versionBeforeSync + 1);
    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(8);
  });
});
