import type { Fixture, Harness, RequestResult } from "./cvctEnv";
import {
  awaitOperationComputation,
  awaitTransferComputation,
  cancelDepositIntentCall,
  cleanupTerminalDepositCall,
  cleanupTerminalRedeemCall,
  cleanupTransferResultCall,
  createCleanupExecutor,
  drainUserBackingTokens,
  expireDepositIntentCall,
  expectCancelDepositRejectedSim,
  expectRedeemCleanupRejectedSim,
  expectSettleDepositRejectedSim,
  expectSettleRedeemRejectedSim,
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
} from "./cvctCore";
import { createFixture } from "./cvctEnv";
import { previewDepositShares, previewRedeemAssets } from "./cvctEnv";
import { waitForPendingDepositCallback, waitForPendingRedeemCallback } from "./cvctAssertions";

export {
  awaitOperationComputation,
  awaitTransferComputation,
  cancelDepositIntentCall,
  cleanupTerminalDepositCall,
  cleanupTerminalRedeemCall,
  cleanupTransferResultCall,
  createCleanupExecutor,
  drainUserBackingTokens,
  expireDepositIntentCall,
  expectCancelDepositRejectedSim,
  expectRedeemCleanupRejectedSim,
  expectSettleDepositRejectedSim,
  expectSettleRedeemRejectedSim,
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
};

export async function createEmptyFixture(harness: Harness): Promise<Fixture> {
  return createFixture(harness);
}

export async function createDepositedFixture(
  harness: Harness,
  amount?: number,
): Promise<{ fixture: Fixture; depositReq: RequestResult }> {
  const fixture = await createFixture(harness);
  const depositAmount = amount ?? fixture.depositAmount;
  const quote = previewDepositShares(depositAmount, 0, 0);
  const depositReq = await requestDeposit(fixture, depositAmount, quote);
  await finalizeAndSettleDeposit(fixture, depositReq);
  return { fixture, depositReq };
}

export async function stageDepositSuccess(
  fixture: Fixture,
  amount?: number,
): Promise<RequestResult> {
  const depositAmount = amount ?? fixture.depositAmount;
  const quote = previewDepositShares(depositAmount, 0, 0);
  const req = await requestDeposit(fixture, depositAmount, quote);
  await waitForPendingDepositCallback(fixture, req.operationPda, req.depositResultPda!);
  return req;
}

export async function createRedeemableFixture(
  harness: Harness,
): Promise<{ fixture: Fixture; depositReq: RequestResult }> {
  return createDepositedFixture(harness);
}

export async function stageRedeemSuccess(
  fixture: Fixture,
  sharesIn?: number,
): Promise<RequestResult> {
  const redeemShares = sharesIn ?? fixture.burnAmount;
  const redeemQuote = previewRedeemAssets(
    redeemShares,
    fixture.depositAmount,
    fixture.depositAmount,
  );
  const req = await requestRedeem(fixture, redeemShares, redeemQuote);
  await waitForPendingRedeemCallback(fixture, req.operationPda, req.redeemResultPda!);
  return req;
}

export async function createDepositedAndStagedRedeemFixture(
  harness: Harness,
): Promise<{ fixture: Fixture; depositReq: RequestResult; redeemReq: RequestResult }> {
  const { fixture, depositReq } = await createDepositedFixture(harness);
  const redeemReq = await stageRedeemSuccess(fixture);
  return { fixture, depositReq, redeemReq };
}
