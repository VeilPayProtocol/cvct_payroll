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

describe("Cvct Races", () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness(false);
  });

  it("[deposit] settle failure after compute leaves custody and canonical state unchanged", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);

    const beforeUser = await fetchUserBackingBalance(fixture);
    const beforeState = await getDecryptedState(fixture);
    await drainUserBackingTokens(fixture, beforeUser);

    await expectRpcFailure(
      settleDepositCall(fixture, req.operationPda, req.depositResultPda),
      "Raw transaction",
    );

    const afterUser = await fetchUserBackingBalance(fixture);
    expect(afterUser).to.equal(0);
    await assertTokenBalances(fixture, 0, 0);

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );
  });

  it("[deposit] reject mismatched staged result wiring before custody movement", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const reqA = await requestDeposit(fixture, fixture.depositAmount, quote);
    const reqB = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, reqA);
    await awaitOperationComputation(fixture, reqB);

    const beforeState = await getDecryptedState(fixture);
    await expectRpcFailure(
      settleDepositCall(fixture, reqA.operationPda, reqB.depositResultPda),
      "A seeds constraint was violated",
    );

    await assertTokenBalances(fixture, 1_000_000, 0);
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
  });

  it("[deposit] invalidates stale callback after a competing deposit settles", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const reqA = await requestDeposit(fixture, fixture.depositAmount, quote);
    const reqB = await requestDeposit(fixture, fixture.depositAmount, quote);

    await finalizeAndSettleDeposit(fixture, reqA);
    const versionAfterA = await fetchPricingVersion(fixture);
    await awaitOperationComputation(fixture, reqB);

    expect(await fetchPendingStatus(fixture, reqB.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterA);
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount,
    );
  });

  it("[deposit] invalidates staged settle after sync version change", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);
    const beforeState = await getDecryptedState(fixture);

    await syncTotalAssetsNoop(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    await settleDepositCall(fixture, req.operationPda, req.depositResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterSync);
    await assertTokenBalances(fixture, 1_000_000, 0);
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
  });

  it("[redeem] rejects mismatched staged result wiring before custody movement", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const reqA = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    const reqB = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, reqA);
    await awaitOperationComputation(fixture, reqB);

    const beforeState = await getDecryptedState(fixture);
    await expectRpcFailure(
      settleRedeemCall(fixture, reqA.operationPda, reqB.redeemResultPda),
      "A seeds constraint was violated",
    );

    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount,
    );
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
  });

  it("[redeem] invalidates stale callback after a competing redeem settles", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const reqA = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    const reqB = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);

    await finalizeAndSettleRedeem(fixture, reqA);
    const versionAfterA = await fetchPricingVersion(fixture);
    await awaitOperationComputation(fixture, reqB);

    expect(await fetchPendingStatus(fixture, reqB.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterA);
  });

  it("[redeem] invalidates staged settle after sync version change", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, depositQuote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const req = await requestRedeem(fixture, fixture.burnAmount, redeemQuote);
    await awaitOperationComputation(fixture, req);
    const beforeState = await getDecryptedState(fixture);

    await syncTotalAssetsNoop(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    await settleRedeemCall(fixture, req.operationPda, req.redeemResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterSync);
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount,
    );
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
  });

  it("[deposit] invalidates when transfer updates user balance before callback", async () => {
    const fixture = await createFixture(harness);
    const initialQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const initialDepositReq = await requestDeposit(
      fixture,
      fixture.depositAmount,
      initialQuote,
    );
    await finalizeAndSettleDeposit(fixture, initialDepositReq);

    const stagedQuote = previewDepositShares(
      fixture.depositAmount,
      fixture.depositAmount,
      fixture.depositAmount,
    );
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, stagedQuote);
    await waitForPendingDepositCallback(
      fixture,
      depositReq.operationPda,
      depositReq.depositResultPda!,
    );
    expect(await fetchPendingStatus(fixture, depositReq.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );

    const beforeState = await getDecryptedState(fixture);
    await transferCvct(fixture, 1);
    await settleDepositCall(fixture, depositReq.operationPda, depositReq.depositResultPda);
    expect(await fetchPendingStatus(fixture, depositReq.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance - BigInt(1));
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
    expect(afterState.balanceVersion).to.equal(beforeState.balanceVersion + 1);
  });

  it("[redeem] invalidates when transfer updates user balance before callback", async () => {
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
    await waitForPendingRedeemCallback(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda!,
    );
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );

    const beforeState = await getDecryptedState(fixture);
    await transferCvct(fixture, fixture.transferAmount);
    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(
      beforeState.decryptedBalance - BigInt(fixture.transferAmount),
    );
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
  });

  it("[transfer] overlapping transfers commit at most one stale snapshot", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(fixture, fixture.depositAmount, quote);
    await finalizeAndSettleDeposit(fixture, depositReq);

    const reqA = await requestTransferCvct(fixture, fixture.transferAmount);
    const reqB = await requestTransferCvct(fixture, 1);
    const resultB = await awaitTransferComputation(fixture, reqB);
    const resultA = await awaitTransferComputation(fixture, reqA);
    expect(resultA.callbackApplied).to.equal(true);
    expect(resultB.callbackApplied).to.equal(true);
    expect(Number(resultA.ok) + Number(resultB.ok)).to.equal(1);

    const afterState = await getDecryptedState(fixture);
    if (resultA.ok) {
      expect(afterState.decryptedBalance).to.equal(
        BigInt(fixture.depositAmount - fixture.transferAmount),
      );
      expect(afterState.decryptedRecipientBalance).to.equal(
        BigInt(fixture.transferAmount),
      );
    } else {
      expect(afterState.decryptedBalance).to.equal(BigInt(fixture.depositAmount - 1));
      expect(afterState.decryptedRecipientBalance).to.equal(BigInt(1));
    }
    expect(afterState.balanceVersion).to.equal(2);
    expect(afterState.recipientBalanceVersion).to.equal(1);
  });

});
