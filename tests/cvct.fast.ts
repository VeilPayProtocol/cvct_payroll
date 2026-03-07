import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  Harness,
  assertEarlySettleRejected,
  assertEncryptedTotals,
  assertTerminalNoopOnResettle,
  assertTokenBalances,
  awaitOperationComputation,
  awaitTransferComputation,
  cancelDepositIntentCall,
  createFixture,
  createHarness,
  createSeededFastFixture,
  drainUserBackingTokens,
  expectRpcFailure,
  expireDepositIntentCall,
  fetchUserBackingBalance,
  fetchPendingDepositResult,
  fetchPendingRedeemResult,
  fetchPendingTransferResult,
  fetchPricingVersion,
  fetchPendingStatus,
  finalizeAndSettleDeposit,
  finalizeAndSettleRedeem,
  getDecryptedState,
  previewDepositShares,
  previewRedeemAssets,
  requestDeposit,
  requestRedeem,
  requestTransferCvct,
  settleDepositCall,
  settleRedeemCall,
  syncTotalAssetsNoop,
  transferCvct,
  waitForPendingDepositCallback,
  waitForPendingRedeemCallback,
} from "./helpers/cvctHarness";

const STATUS_SETTLED = 3;
const STATUS_FAILED = 5;
const STATUS_CANCELLED = 6;
const STATUS_EXPIRED = 7;
const STATUS_INVALIDATED = 8;
const STATUS_COMPUTED_SUCCESS = 1;

describe("Cvct Fast", () => {
  let harness: Harness;
  let seededFixture: Awaited<ReturnType<typeof createSeededFastFixture>>;

  before(async () => {
    harness = await createHarness(false);
    seededFixture = await createSeededFastFixture(harness);
  });

  it("[math] validates deterministic share math vectors and invariants", async () => {
    const bootstrapShares = previewDepositShares(500_000, 0, 0);
    expect(bootstrapShares).to.equal(500_000);

    const supplyBefore = 1_000_000;
    const assetsBefore = 1_200_000;
    const sharesOut = previewDepositShares(100_000, supplyBefore, assetsBefore);
    const assetsOut = previewRedeemAssets(100_000, supplyBefore, assetsBefore);

    expect(sharesOut).to.be.lessThan(100_000);
    expect(assetsOut).to.be.greaterThan(100_000);

    for (let i = 1; i <= 250; i += 1) {
      const assets = i * 13 + 19;
      const supply = i * 11 + 17;
      const depositIn = i * 7 + 1;
      const minted = previewDepositShares(depositIn, supply, assets);
      if (minted === 0) continue;

      const redeemed = previewRedeemAssets(minted, supply + minted, assets + depositIn);
      expect(redeemed).to.be.lte(depositIn);
    }
  });

  it("[init] initializes mint + account state", async () => {
    const state = await getDecryptedState(seededFixture);

    expect(state.decryptedBalance).to.equal(BigInt(0));
    expect(state.decryptedRecipientBalance).to.equal(BigInt(0));
    expect(state.decryptedSupply).to.equal(BigInt(0));
    expect(state.decryptedLocked).to.equal(BigInt(0));
  });

  it("[deposit] request rejects early settle before callback", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await assertEarlySettleRejected(
      settleDepositCall(fixture, req.operationPda, req.depositResultPda),
    );
  });

  it("[deposit] callback stages result without moving funds or mutating canonical state", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await assertTokenBalances(fixture, 1_000_000, 0);
    await awaitOperationComputation(fixture, req);

    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(BigInt(0));
    expect(state.decryptedSupply).to.equal(BigInt(0));
    expect(state.decryptedLocked).to.equal(BigInt(0));

    const staged = await fetchPendingDepositResult(fixture, req.depositResultPda!);
    const op = await (fixture.harness.program.account as any).pendingOperation.fetch(
      req.operationPda,
    );
    expect(staged.ok).to.equal(true);
    expect(Number(staged.sharesOut)).to.equal(quote);
    expect(staged.operationId.toString()).to.equal(op.operationId.toString());
    expect(staged.cvctMint.toBase58()).to.equal(fixture.cvctMintPda.toBase58());
    expect(staged.user.toBase58()).to.equal(harness.payer.publicKey.toBase58());
  });

  it("[deposit] settles success path and is idempotent", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await finalizeAndSettleDeposit(fixture, req);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_SETTLED);
    await assertTokenBalances(fixture, 1_000_000 - fixture.depositAmount, fixture.depositAmount);

    await assertTerminalNoopOnResettle(() =>
      settleDepositCall(fixture, req.operationPda, req.depositResultPda),
    );
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_SETTLED);
    const state = await getDecryptedState(fixture);
    expect(state.balanceVersion).to.equal(1);
  });

  it("[deposit] fails without custody movement when callback marks an invalid quote", async () => {
    const fixture = await createFixture(harness);
    const req = await requestDeposit(fixture, fixture.depositAmount, 1, {
      quotedSharesOut: fixture.depositAmount * 10,
    });

    await finalizeAndSettleDeposit(fixture, req);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_FAILED);

    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(BigInt(0));
    expect(state.decryptedSupply).to.equal(BigInt(0));
    expect(state.decryptedLocked).to.equal(BigInt(0));

    await assertTokenBalances(fixture, 1_000_000, 0);
  });

  it("[deposit] rejects zero asset requests", async () => {
    await expectRpcFailure(
      requestDeposit(seededFixture, 0, 1),
      "Amount must be greater than zero",
    );
  });

  it("[deposit] cancel succeeds while requested and leaves state unchanged", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await cancelDepositIntentCall(fixture, req.operationPda, req.depositResultPda);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_CANCELLED);
    await assertTokenBalances(fixture, 1_000_000, 0);

    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(BigInt(0));
    expect(state.decryptedSupply).to.equal(BigInt(0));
    expect(state.decryptedLocked).to.equal(BigInt(0));
  });

  it("[deposit] cancel rejects after callback has been applied", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);

    await expectRpcFailure(
      cancelDepositIntentCall(fixture, req.operationPda, req.depositResultPda),
      "Invalid operation phase for this instruction",
    );
  });

  it("[deposit] expire marks unresolved requests terminal after deadline", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const currentSlot = await harness.connection.getSlot("confirmed");
    const req = await requestDeposit(fixture, fixture.depositAmount, quote, {
      deadlineSlot: new anchor.BN(currentSlot - 1),
    });

    await expireDepositIntentCall(fixture, req.operationPda, req.depositResultPda);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_EXPIRED);
    await assertTokenBalances(fixture, 1_000_000, 0);
  });

  it("[redeem] request rejects early settle before callback", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);

    await assertEarlySettleRejected(
      settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda),
    );
  });

  it("[redeem] callback stages result without mutating canonical state", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    const beforeState = await getDecryptedState(fixture);
    await awaitOperationComputation(fixture, redeemReq);

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);

    const staged = await fetchPendingRedeemResult(fixture, redeemReq.redeemResultPda!);
    const op = await (fixture.harness.program.account as any).pendingOperation.fetch(
      redeemReq.operationPda,
    );
    expect(staged.ok).to.equal(true);
    expect(Number(staged.assetsOut)).to.equal(redeemQuote);
    expect(staged.operationId.toString()).to.equal(op.operationId.toString());
    expect(staged.cvctMint.toBase58()).to.equal(fixture.cvctMintPda.toBase58());
    expect(staged.user.toBase58()).to.equal(harness.payer.publicKey.toBase58());
  });

  it("[redeem] settles success/failure path and is idempotent", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const successQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const successReq = await requestRedeem(fixture, fixture.burnAmount, successQuote);
    await finalizeAndSettleRedeem(fixture, successReq);
    expect(await fetchPendingStatus(fixture, successReq.operationPda)).to.equal(
      STATUS_SETTLED,
    );
    let state = await getDecryptedState(fixture);
    expect(state.balanceVersion).to.equal(2);

    await assertTerminalNoopOnResettle(() =>
      settleRedeemCall(fixture, successReq.operationPda, successReq.redeemResultPda),
    );
    expect(await fetchPendingStatus(fixture, successReq.operationPda)).to.equal(
      STATUS_SETTLED,
    );

    const failureReq = await requestRedeem(fixture, fixture.depositAmount * 10, 1);
    await finalizeAndSettleRedeem(fixture, failureReq);
    expect(await fetchPendingStatus(fixture, failureReq.operationPda)).to.equal(
      STATUS_FAILED,
    );

    await assertTerminalNoopOnResettle(() =>
      settleRedeemCall(fixture, failureReq.operationPda, failureReq.redeemResultPda),
    );
    expect(await fetchPendingStatus(fixture, failureReq.operationPda)).to.equal(
      STATUS_FAILED,
    );
    state = await getDecryptedState(fixture);
    expect(state.balanceVersion).to.equal(2);
  });

  it("[redeem] rejects zero share requests", async () => {
    await expectRpcFailure(
      requestRedeem(seededFixture, 0, 1),
      "Amount must be greater than zero",
    );
  });

  it("[transfer] updates sender/recipient only", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await finalizeAndSettleDeposit(fixture, req);

    await transferCvct(fixture, fixture.transferAmount);
    const state = await getDecryptedState(fixture);

    expect(state.decryptedBalance).to.equal(
      BigInt(fixture.depositAmount - fixture.transferAmount),
    );
    expect(state.decryptedRecipientBalance).to.equal(BigInt(fixture.transferAmount));
    expect(state.decryptedSupply).to.equal(BigInt(fixture.depositAmount));
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount));
    expect(state.balanceVersion).to.equal(2);
    expect(state.recipientBalanceVersion).to.equal(1);
  });

  it("[invariant] global accounting invariants hold after deposit+redeem", async () => {
    const fixture = await createFixture(harness);

    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const redeemReq = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await finalizeAndSettleRedeem(fixture, redeemReq);

    const state = await getDecryptedState(fixture);
    const expectedSupply = BigInt(fixture.depositAmount - fixture.burnAmount);
    const expectedLocked = BigInt(fixture.depositAmount - fixture.burnAmount);

    assertEncryptedTotals(
      state.decryptedSupply,
      state.decryptedLocked,
      expectedSupply,
      expectedLocked,
    );

    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount + fixture.burnAmount,
      fixture.depositAmount - fixture.burnAmount,
    );
  });
});
