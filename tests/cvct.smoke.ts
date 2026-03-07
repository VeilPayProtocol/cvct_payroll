import { expect } from "chai";
import {
  assertEncryptedTotals,
  assertTokenBalances,
  expectRpcFailure,
  getDecryptedState,
} from "./helpers/cvctAssertions";
import {
  createDepositedFixture,
  finalizeAndSettleDeposit,
  finalizeAndSettleRedeem,
  requestDeposit,
  requestRedeem,
  requestTransferCvct,
  transferCvct,
} from "./helpers/cvctFlows";
import {
  type Harness,
  createFixture,
  createHarness,
  createSeededFastFixture,
  previewDepositShares,
  previewRedeemAssets,
} from "./helpers/cvctEnv";

describe("Cvct Smoke", () => {
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

      const redeemed = previewRedeemAssets(
        minted,
        supply + minted,
        assets + depositIn
      );
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

  it("[deposit] commits a simple happy-path deposit", async () => {
    const fixture = await createFixture(harness);
    const quote = previewDepositShares(fixture.depositAmount, 0, 0);
    const req = await requestDeposit(fixture, fixture.depositAmount, quote);

    await finalizeAndSettleDeposit(fixture, req);
    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount,
      fixture.depositAmount
    );

    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(BigInt(fixture.depositAmount));
    expect(state.decryptedSupply).to.equal(BigInt(fixture.depositAmount));
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount));
    expect(state.balanceVersion).to.equal(1);
  });

  it("[deposit] rejects zero asset requests", async () => {
    await expectRpcFailure(
      requestDeposit(seededFixture, 0, 1),
      "Amount must be greater than zero"
    );
  });

  it("[redeem] commits a simple happy-path redeem", async () => {
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
    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(
      BigInt(fixture.depositAmount - fixture.burnAmount)
    );
    expect(state.decryptedSupply).to.equal(
      BigInt(fixture.depositAmount - fixture.burnAmount)
    );
    expect(state.decryptedLocked).to.equal(
      BigInt(fixture.depositAmount - fixture.burnAmount)
    );
    expect(state.balanceVersion).to.equal(2);
  });

  it("[redeem] rejects zero share requests", async () => {
    await expectRpcFailure(
      requestRedeem(seededFixture, 0, 1),
      "Amount must be greater than zero"
    );
  });

  it("[transfer] updates sender/recipient only", async () => {
    const { fixture } = await createDepositedFixture(harness);
    await transferCvct(fixture, fixture.transferAmount);

    const state = await getDecryptedState(fixture);
    expect(state.decryptedBalance).to.equal(
      BigInt(fixture.depositAmount - fixture.transferAmount)
    );
    expect(state.decryptedRecipientBalance).to.equal(
      BigInt(fixture.transferAmount)
    );
    expect(state.decryptedSupply).to.equal(BigInt(fixture.depositAmount));
    expect(state.decryptedLocked).to.equal(BigInt(fixture.depositAmount));
    expect(state.balanceVersion).to.equal(2);
    expect(state.recipientBalanceVersion).to.equal(1);
  });

  it("[transfer] rejects self-transfer without mutating balances", async () => {
    const { fixture } = await createDepositedFixture(harness);
    const beforeState = await getDecryptedState(fixture);

    await expectRpcFailure(
      requestTransferCvct(fixture, fixture.transferAmount, {
        toCvctAccount: fixture.cvctAccountPda,
        toEncPubkey: fixture.accountEncPubkey,
      }),
      "Self-transfer is not allowed"
    );

    const afterState = await getDecryptedState(fixture);
    expect(afterState.decryptedBalance).to.equal(beforeState.decryptedBalance);
    expect(afterState.decryptedRecipientBalance).to.equal(
      beforeState.decryptedRecipientBalance
    );
    expect(afterState.decryptedSupply).to.equal(beforeState.decryptedSupply);
    expect(afterState.decryptedLocked).to.equal(beforeState.decryptedLocked);
    expect(afterState.balanceVersion).to.equal(beforeState.balanceVersion);
    expect(afterState.recipientBalanceVersion).to.equal(
      beforeState.recipientBalanceVersion
    );
  });

  it("[invariant] global accounting invariants hold after deposit+redeem", async () => {
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

    const state = await getDecryptedState(fixture);
    const expectedSupply = BigInt(fixture.depositAmount - fixture.burnAmount);
    const expectedLocked = BigInt(fixture.depositAmount - fixture.burnAmount);

    assertEncryptedTotals(
      state.decryptedSupply,
      state.decryptedLocked,
      expectedSupply,
      expectedLocked
    );

    await assertTokenBalances(
      fixture,
      1_000_000 - fixture.depositAmount + fixture.burnAmount,
      fixture.depositAmount - fixture.burnAmount
    );
  });
});
