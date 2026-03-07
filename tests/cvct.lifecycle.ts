import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  accountExists,
  assertTerminalNoopOnResettle,
  assertTokenBalances,
  fetchPendingDepositResult,
  fetchPendingRedeemResult,
  fetchPendingStatus,
  getDecryptedState,
  waitForPendingDepositCallback,
  waitForPendingRedeemCallback,
} from "./helpers/cvctAssertions";
import {
  advancePastSlot,
  awaitOperationComputation,
  awaitTransferComputation,
  cancelDepositIntentCall,
  cleanupTerminalDepositCall,
  cleanupTerminalRedeemCall,
  cleanupTransferResultCall,
  createDepositedFixture,
  createCleanupExecutor,
  expireDepositIntentCall,
  expectCancelDepositRejectedSim,
  expectRedeemCleanupRejectedSim,
  expectSettleDepositRejectedSim,
  expectSettleRedeemRejectedSim,
  finalizeAndSettleDeposit,
  finalizeAndSettleRedeem,
  requestDeposit,
  requestRedeem,
  requestTransferCvct,
  settleDepositCall,
  settleRedeemCall,
} from "./helpers/cvctFlows";
import {
  type Harness,
  type Fixture,
  createHarness,
  createFixture,
  previewDepositShares,
  previewRedeemAssets,
} from "./helpers/cvctEnv";

const STATUS_SETTLED = 3;
const STATUS_FAILED = 5;
const STATUS_CANCELLED = 6;
const STATUS_EXPIRED = 7;

describe("Cvct Lifecycle", () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness(false);
  });

  it("[deposit] request rejects early settle before callback", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await expectSettleDepositRejectedSim(
      fixture,
      req.operationPda,
      req.depositResultPda,
      "Operation has not been computed yet"
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

    const staged = await fetchPendingDepositResult(
      fixture,
      req.depositResultPda!
    );
    const op = await (
      fixture.harness.program.account as any
    ).pendingOperation.fetch(req.operationPda);
    expect(staged.ok).to.equal(true);
    expect(Number(staged.sharesOut)).to.equal(quote);
    expect(staged.operationId.toString()).to.equal(op.operationId.toString());
  });

  it("[deposit] settles success path and is idempotent", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await finalizeAndSettleDeposit(fixture, req);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_SETTLED
    );

    await assertTerminalNoopOnResettle(() =>
      settleDepositCall(fixture, req.operationPda, req.depositResultPda)
    );
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_SETTLED
    );
  });

  it("[deposit] fails without custody movement when callback marks an invalid quote", async () => {
    const fixture = await createFixture(harness);
    const req = await requestDeposit(fixture, fixture.depositAmount, 1, {
      quotedSharesOut: fixture.depositAmount * 10,
    });

    await finalizeAndSettleDeposit(fixture, req);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_FAILED
    );
    await assertTokenBalances(fixture, 1_000_000, 0);
  });

  it("[deposit] cancel succeeds while requested and leaves state unchanged", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await cancelDepositIntentCall(
      fixture,
      req.operationPda,
      req.depositResultPda
    );
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_CANCELLED
    );
  });

  it("[deposit] cancel rejects after callback has been applied", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await awaitOperationComputation(fixture, req);

    await expectCancelDepositRejectedSim(
      fixture,
      req.operationPda,
      req.depositResultPda,
      "Invalid operation phase for this instruction"
    );
  });

  it("[deposit] expire marks unresolved requests terminal after deadline", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const currentSlot = await harness.connection.getSlot("confirmed");
    const req = await requestDeposit(fixture, fixture.depositAmount, quote, {
      deadlineSlot: new anchor.BN(currentSlot - 1),
    });

    await expireDepositIntentCall(
      fixture,
      req.operationPda,
      req.depositResultPda
    );
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_EXPIRED
    );
  });

  it("[deposit] settle auto-expires staged deposits after deadline", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const currentSlot = await harness.connection.getSlot("confirmed");
    const req = await requestDeposit(fixture, fixture.depositAmount, quote, {
      deadlineSlot: new anchor.BN(currentSlot + 20),
    });

    await awaitOperationComputation(fixture, req);
    await waitForPendingDepositCallback(
      fixture,
      req.operationPda,
      req.depositResultPda!
    );

    const beforeState = await getDecryptedState(fixture);
    await assertTokenBalances(fixture, 1_000_000, 0);
    await advancePastSlot(fixture, req.deadlineSlot!.toNumber());

    await settleDepositCall(fixture, req.operationPda, req.depositResultPda);

    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(
      STATUS_EXPIRED
    );
    await assertTokenBalances(fixture, 1_000_000, 0);

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);

    await cleanupTerminalDepositCall(
      fixture,
      req.operationPda,
      req.depositResultPda!
    );
    expect(await accountExists(fixture, req.operationPda)).to.equal(false);
    expect(await accountExists(fixture, req.depositResultPda!)).to.equal(false);
  });

  it("[deposit] cleanup closes settled terminal PDAs and returns lamports to user", async () => {
    const fixture = await createFixture(harness);
    const executor = await createCleanupExecutor(fixture);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);
    await finalizeAndSettleDeposit(fixture, req);

    const beforeLamports = await harness.connection.getBalance(
      harness.payer.publicKey,
      "confirmed"
    );
    await cleanupTerminalDepositCall(
      fixture,
      req.operationPda,
      req.depositResultPda!,
      executor
    );
    const afterLamports = await harness.connection.getBalance(
      harness.payer.publicKey,
      "confirmed"
    );

    expect(await accountExists(fixture, req.operationPda)).to.equal(false);
    expect(await accountExists(fixture, req.depositResultPda!)).to.equal(false);
    expect(afterLamports).to.be.greaterThan(beforeLamports);
  });

  it("[redeem] request rejects early settle before callback", async () => {
    const { fixture } = await createDepositedFixture(harness);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount
    );
    const redeemReq = await requestRedeem(
      fixture,
      fixture.burnAmount,
      redeemQuote
    );

    await expectSettleRedeemRejectedSim(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda,
      "Operation has not been computed yet"
    );
  });

  it("[redeem] callback stages result without mutating canonical state", async () => {
    const { fixture } = await createDepositedFixture(harness);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount
    );
    const redeemReq = await requestRedeem(
      fixture,
      fixture.burnAmount,
      redeemQuote
    );
    const beforeState = await getDecryptedState(fixture);
    await awaitOperationComputation(fixture, redeemReq);

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);

    const staged = await fetchPendingRedeemResult(
      fixture,
      redeemReq.redeemResultPda!
    );
    expect(staged.ok).to.equal(true);
    expect(Number(staged.assetsOut)).to.equal(redeemQuote);
  });

  it("[redeem] settles success/failure path and is idempotent", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(
      fixture,
      fixture.depositAmount,
      depositQuote
    );
    await finalizeAndSettleDeposit(fixture, depositReq);

    const successQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount
    );
    const successReq = await requestRedeem(
      fixture,
      fixture.burnAmount,
      successQuote
    );
    await finalizeAndSettleRedeem(fixture, successReq);
    expect(await fetchPendingStatus(fixture, successReq.operationPda)).to.equal(
      STATUS_SETTLED
    );

    await assertTerminalNoopOnResettle(() =>
      settleRedeemCall(
        fixture,
        successReq.operationPda,
        successReq.redeemResultPda
      )
    );
    expect(await fetchPendingStatus(fixture, successReq.operationPda)).to.equal(
      STATUS_SETTLED
    );

    const failureReq = await requestRedeem(
      fixture,
      fixture.depositAmount * 10,
      1
    );
    await finalizeAndSettleRedeem(fixture, failureReq);
    expect(await fetchPendingStatus(fixture, failureReq.operationPda)).to.equal(
      STATUS_FAILED
    );
  });

  it("[redeem] cleanup rejects non-terminal computed-success ops", async () => {
    const { fixture } = await createDepositedFixture(harness);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount
    );
    const redeemReq = await requestRedeem(
      fixture,
      fixture.burnAmount,
      redeemQuote
    );
    await waitForPendingRedeemCallback(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda!
    );

    await expectRedeemCleanupRejectedSim(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda!,
      "Invalid operation phase for this instruction"
    );
  });

  it("[redeem] cleanup closes settled terminal PDAs", async () => {
    const { fixture } = await createDepositedFixture(harness);

    const redeemQuote = previewRedeemAssets(
      fixture.burnAmount,
      fixture.depositAmount,
      fixture.depositAmount
    );
    const redeemReq = await requestRedeem(
      fixture,
      fixture.burnAmount,
      redeemQuote
    );

    await finalizeAndSettleRedeem(fixture, redeemReq);
    await cleanupTerminalRedeemCall(
      fixture,
      redeemReq.operationPda,
      redeemReq.redeemResultPda!
    );

    expect(await accountExists(fixture, redeemReq.operationPda)).to.equal(
      false
    );
    expect(await accountExists(fixture, redeemReq.redeemResultPda!)).to.equal(
      false
    );
  });

  it("[transfer] cleanup closes transfer result after callback", async () => {
    const fixture = await createFixture(harness);
    const depositQuote = previewDepositShares(fixture.depositAmount, 0, 0);
    const depositReq = await requestDeposit(
      fixture,
      fixture.depositAmount,
      depositQuote
    );
    await finalizeAndSettleDeposit(fixture, depositReq);

    const transferReq = await requestTransferCvct(
      fixture,
      fixture.transferAmount
    );
    await awaitTransferComputation(fixture, transferReq);
    await cleanupTransferResultCall(fixture, transferReq.transferResultPda!);

    expect(
      await accountExists(fixture, transferReq.transferResultPda!)
    ).to.equal(false);
  });
});
