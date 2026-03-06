import { expect } from "chai";
import {
  Harness,
  assertEarlySettleRejected,
  assertEncryptedTotals,
  assertTerminalNoopOnResettle,
  assertTokenBalances,
  createFixture,
  createHarness,
  fetchPendingStatus,
  finalizeAndSettleDeposit,
  finalizeAndSettleRedeem,
  getDecryptedState,
  previewDepositShares,
  previewRedeemAssets,
  requestDeposit,
  requestRedeem,
  settleDepositCall,
  settleRedeemCall,
  transferCvct,
} from "./helpers/cvctHarness";

const STATUS_SETTLED = 3;
const STATUS_FAILED = 5;

describe("Cvct", () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness(false);
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
    const fixture = await createFixture(harness);
    const state = await getDecryptedState(fixture);

    expect(state.decryptedBalance).to.equal(BigInt(0));
    expect(state.decryptedRecipientBalance).to.equal(BigInt(0));
    expect(state.decryptedSupply).to.equal(BigInt(0));
    expect(state.decryptedLocked).to.equal(BigInt(0));
  });

  it("[deposit] request rejects early settle before callback", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await assertEarlySettleRejected(settleDepositCall(fixture, req.operationPda));
  });

  it("[deposit] settles success path and is idempotent", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await finalizeAndSettleDeposit(fixture, req);
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_SETTLED);

    await assertTerminalNoopOnResettle(() => settleDepositCall(fixture, req.operationPda));
    expect(await fetchPendingStatus(fixture, req.operationPda)).to.equal(STATUS_SETTLED);
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

    await assertEarlySettleRejected(settleRedeemCall(fixture, redeemReq.operationPda));
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

    await assertTerminalNoopOnResettle(() => settleRedeemCall(fixture, successReq.operationPda));
    expect(await fetchPendingStatus(fixture, successReq.operationPda)).to.equal(
      STATUS_SETTLED,
    );

    const failureReq = await requestRedeem(fixture, fixture.depositAmount * 10, 1);
    await finalizeAndSettleRedeem(fixture, failureReq);
    expect(await fetchPendingStatus(fixture, failureReq.operationPda)).to.equal(
      STATUS_FAILED,
    );

    await assertTerminalNoopOnResettle(() => settleRedeemCall(fixture, failureReq.operationPda));
    expect(await fetchPendingStatus(fixture, failureReq.operationPda)).to.equal(
      STATUS_FAILED,
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
