import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  accountExists,
  assertEncryptedTotals,
  assertTerminalNoopOnResettle,
  assertTokenBalances,
  expectRpcFailure,
  fetchUserBackingBalance,
  fetchPendingDepositResult,
  fetchPendingRedeemResult,
  fetchPricingVersion,
  fetchPendingStatus,
  getDecryptedState,
  waitForPendingDepositCallback,
  waitForPendingRedeemCallback,
} from "./helpers/cvctAssertions";
import {
  awaitOperationComputation,
  awaitTransferComputation,
  cleanupTerminalDepositCall,
  cleanupTerminalRedeemCall,
  cleanupTransferResultCall,
  drainUserBackingTokens,
  failedTransferCvct,
  finalizeAndSettleDeposit,
  finalizeAndSettleRedeem,
  requestDeposit,
  requestRedeem,
  requestTransferCvct,
  settleDepositCall,
  settleRedeemCall,
  syncTotalAssetsChanged,
  syncTotalAssetsNoop,
  transferCvct,
} from "./helpers/cvctFlows";
import {
  type Harness,
  createHarness,
  createFixture,
  previewDepositShares,
  previewRedeemAssets,
} from "./helpers/cvctEnv";

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

  it("[deposit] preserves staged settle after no-op sync", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);
    const versionBeforeSync = await fetchPricingVersion(fixture);

    await syncTotalAssetsNoop(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    expect(versionAfterSync).to.equal(versionBeforeSync);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );
    await settleDepositCall(fixture, req.operationPda, req.depositResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_SETTLED,
    );
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount,
    );
  });

  it("[deposit] invalidates staged settle after changed sync version", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);

    const versionBeforeSync = await fetchPricingVersion(fixture);
    await syncTotalAssetsChanged(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    expect(versionAfterSync).to.equal(versionBeforeSync + 1);
    await settleDepositCall(fixture, req.operationPda, req.depositResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    const op = await (fixture.harness.program.account as any).pendingOperation.fetch(
      req.operationPda,
    );
    const result = await fetchPendingDepositResult(fixture, req.depositResultPda!);
    expect(op.ok).to.equal(false);
    expect(Number(op.amountOut)).to.equal(0);
    expect(result.ok).to.equal(false);
    expect(Number(result.sharesOut)).to.equal(0);
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterSync);
    await assertTokenBalances(fixture, 1_000_000, 0);
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

  it("[redeem] preserves staged settle after no-op sync", async () => {
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
    const versionBeforeSync = await fetchPricingVersion(fixture);

    await syncTotalAssetsNoop(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    expect(versionAfterSync).to.equal(versionBeforeSync);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );
    await settleRedeemCall(fixture, req.operationPda, req.redeemResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_SETTLED,
    );
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount + fixture.burnAmount,
      fixture.depositAmount - fixture.burnAmount,
    );
  });

  it("[redeem] invalidates staged settle after changed sync version", async () => {
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

    const versionBeforeSync = await fetchPricingVersion(fixture);
    await syncTotalAssetsChanged(fixture);
    const versionAfterSync = await fetchPricingVersion(fixture);
    expect(versionAfterSync).to.equal(versionBeforeSync + 1);
    await settleRedeemCall(fixture, req.operationPda, req.redeemResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );
    const op = await (fixture.harness.program.account as any).pendingOperation.fetch(
      req.operationPda,
    );
    const result = await fetchPendingRedeemResult(fixture, req.redeemResultPda!);
    expect(op.ok).to.equal(false);
    expect(Number(op.amountOut)).to.equal(0);
    expect(result.ok).to.equal(false);
    expect(Number(result.assetsOut)).to.equal(0);
    expect(await fetchPricingVersion(fixture)).to.equal(versionAfterSync);
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount,
    );
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

  it("[deposit] cleanup closes invalidated terminal PDAs", async () => {
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
    await transferCvct(fixture, 1);
    await settleDepositCall(fixture, depositReq.operationPda, depositReq.depositResultPda);
    expect(await fetchPendingStatus(fixture, depositReq.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );

    await cleanupTerminalDepositCall(
      fixture,
      depositReq.operationPda,
      depositReq.depositResultPda!,
    );
    expect(await accountExists(fixture, depositReq.operationPda)).to.equal(false);
    expect(await accountExists(fixture, depositReq.depositResultPda!)).to.equal(false);
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

  it("[redeem] cleanup closes invalidated terminal PDAs", async () => {
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
    await transferCvct(fixture, fixture.transferAmount);
    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(
      STATUS_INVALIDATED,
    );

    await cleanupTerminalRedeemCall(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda!,
    );
    expect(await accountExists(fixture, redeemReq.operationPda)).to.equal(false);
    expect(await accountExists(fixture, redeemReq.redeemResultPda!)).to.equal(false);
  });

  it("[transfer] failed transfer preserves canonical state and versions", async () => {
    const fixture = await createFixture(harness);
    const beforeState = await getDecryptedState(fixture);

    const result = await failedTransferCvct(fixture, 1);
    expect(result.callbackApplied).to.equal(true);
    expect(result.ok).to.equal(false);

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedRecipientBalance).to.equal(
      beforeState.decryptedRecipientBalance,
    );
    expect(afterState.balanceVersion).to.equal(beforeState.balanceVersion);
    expect(afterState.recipientBalanceVersion).to.equal(
      beforeState.recipientBalanceVersion,
    );
  });

  it("[transfer] cleanup closes failed transfer result after callback", async () => {
    const fixture = await createFixture(harness);
    const req = await requestTransferCvct(fixture, 1);
    const result = await awaitTransferComputation(fixture, req);
    expect(result.callbackApplied).to.equal(true);
    expect(result.ok).to.equal(false);

    await cleanupTransferResultCall(fixture, req.transferResultPda!);
    expect(await accountExists(fixture, req.transferResultPda!)).to.equal(false);
  });

  it("[deposit] failed transfer does not invalidate staged deposit", async () => {
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
    const failedAmount = fixture.depositAmount * 10;
    const failedTransfer = await failedTransferCvct(fixture, failedAmount);
    expect(failedTransfer.ok).to.equal(false);

    const afterFailedTransfer = await getDecryptedState(fixture);
    expect(afterFailedTransfer.balanceVersion).to.equal(beforeState.balanceVersion);
    expect(await fetchPendingStatus(fixture, depositReq.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );

    await settleDepositCall(fixture, depositReq.operationPda, depositReq.depositResultPda);
    expect(await fetchPendingStatus(fixture, depositReq.operationPda)).to.equal(
      STATUS_SETTLED,
    );
  });

  it("[redeem] failed transfer does not invalidate staged redeem", async () => {
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
    const failedAmount = fixture.depositAmount * 10;
    const failedTransfer = await failedTransferCvct(fixture, failedAmount);
    expect(failedTransfer.ok).to.equal(false);

    const afterFailedTransfer = await getDecryptedState(fixture);
    expect(afterFailedTransfer.balanceVersion).to.equal(beforeState.balanceVersion);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(
      STATUS_COMPUTED_SUCCESS,
    );

    await settleRedeemCall(fixture, redeemReq.operationPda, redeemReq.redeemResultPda);
    expect(await fetchPendingStatus(fixture, redeemReq.operationPda)).to.equal(
      STATUS_SETTLED,
    );
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
