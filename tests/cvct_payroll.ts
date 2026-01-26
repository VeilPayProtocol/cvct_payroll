import * as anchor from "@coral-xyz/anchor";
import type { CvctPayroll } from "../target/types/cvct_payroll.js";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import { expect } from "chai";
import nacl from "tweetnacl";
import * as incoSdk from "@inco/solana-sdk";

// Destructure for convenience
const BN = anchor.BN;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
} = splToken;
const { encryptValue, decrypt, hexToBuffer } = incoSdk;

// =============================================================================
// CONSTANTS
// =============================================================================

const INCO_LIGHTNING_PROGRAM_ID = new PublicKey(
  "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
);

const PAYROLL_INTERVAL_SECONDS = 60; // 1 minute for testing
const RATE_PER_INTERVAL = BigInt(1_000_000_000); // 1 token per interval
const DEPOSIT_AMOUNT = 100_000_000_000; // 100 tokens

// =============================================================================
// HELPER TYPES
// =============================================================================

interface TestContext {
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: anchor.Program<CvctPayroll>;
  payer: Keypair;
  backingMint: PublicKey;
  cvctMintPda: PublicKey;
  vaultPda: PublicKey;
  vaultTokenAccount: PublicKey;
}

interface OrgContext extends TestContext {
  orgPda: PublicKey;
  orgTreasuryPda: PublicKey;
  payrollPda: PublicKey;
}

interface MemberContext {
  wallet: Keypair;
  cvctAccountPda: PublicKey;
  payrollMemberPda: PublicKey;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Extract handle from Anchor's representation of Euint128
 */
function extractHandle(anchorHandle: any): bigint {
  if (anchorHandle && anchorHandle._bn) {
    return BigInt(anchorHandle._bn.toString(10));
  }
  if (typeof anchorHandle === "object" && anchorHandle["0"]) {
    const nested = anchorHandle["0"];
    if (nested && nested._bn) return BigInt(nested._bn.toString(10));
    if (nested?.toString && nested.constructor?.name === "BN") {
      return BigInt(nested.toString(10));
    }
  }
  if (anchorHandle instanceof Uint8Array || Array.isArray(anchorHandle)) {
    const buffer = Buffer.from(anchorHandle);
    let result = BigInt(0);
    for (let i = buffer.length - 1; i >= 0; i--) {
      result = result * BigInt(256) + BigInt(buffer[i]);
    }
    return result;
  }
  if (typeof anchorHandle === "number" || typeof anchorHandle === "bigint") {
    return BigInt(anchorHandle);
  }
  return BigInt(0);
}

/**
 * Compute allowance PDA for Inco Lightning
 */
function getAllowancePda(
  handle: bigint,
  allowedAddress: PublicKey
): [PublicKey, number] {
  const handleBuffer = Buffer.alloc(16);
  let h = handle;
  for (let i = 0; i < 16; i++) {
    handleBuffer[i] = Number(h & BigInt(0xff));
    h = h >> BigInt(8);
  }
  return PublicKey.findProgramAddressSync(
    [handleBuffer, allowedAddress.toBuffer()],
    INCO_LIGHTNING_PROGRAM_ID
  );
}

/**
 * Format balance from raw amount with decimals
 */
function formatBalance(plaintext: string, decimals = 9): string {
  return (Number(plaintext) / 10 ** decimals).toFixed(decimals);
}

/**
 * Wait for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Airdrop SOL to a keypair
 */
async function airdrop(
  connection: Connection,
  to: PublicKey,
  amount: number = 2 * LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await connection.requestAirdrop(to, amount);
  await connection.confirmTransaction(sig, "confirmed");
}

// =============================================================================
// DECRYPTION HELPERS
// =============================================================================

/**
 * Decrypt an encrypted handle value
 */
async function decryptHandle(
  handle: string,
  walletKeypair: Keypair
): Promise<{ success: boolean; plaintext?: string; error?: string }> {
  await sleep(2000); // Allow time for Inco network
  try {
    const result = await decrypt([handle], {
      address: walletKeypair.publicKey,
      signMessage: async (message: Uint8Array) =>
        nacl.sign.detached(message, walletKeypair.secretKey),
    });
    return { success: true, plaintext: result.plaintexts[0] };
  } catch (error: any) {
    const msg = error.message || error.toString();
    if (msg.toLowerCase().includes("not allowed"))
      return { success: false, error: "not_allowed" };
    if (msg.toLowerCase().includes("ciphertext"))
      return { success: false, error: "ciphertext_not_found" };
    return { success: false, error: msg };
  }
}

// =============================================================================
// PDA DERIVATION HELPERS
// =============================================================================

function deriveCvctMintPda(
  programId: PublicKey,
  authority: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("cvct_mint"), authority.toBuffer()],
    programId
  );
}

function deriveVaultPda(
  programId: PublicKey,
  authority: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    programId
  );
}

function deriveCvctAccountPda(
  programId: PublicKey,
  cvctMint: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("cvct_account"), cvctMint.toBuffer(), owner.toBuffer()],
    programId
  );
}

function deriveOrgPda(
  programId: PublicKey,
  authority: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("org"), authority.toBuffer()],
    programId
  );
}

function deriveOrgTreasuryPda(
  programId: PublicKey,
  org: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("org_treasury"), org.toBuffer()],
    programId
  );
}

function derivePayrollPda(
  programId: PublicKey,
  org: PublicKey,
  admin: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("payroll"), org.toBuffer(), admin.toBuffer()],
    programId
  );
}

function derivePayrollMemberPda(
  programId: PublicKey,
  payroll: PublicKey,
  recipient: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("payroll_member"), payroll.toBuffer(), recipient.toBuffer()],
    programId
  );
}

// =============================================================================
// SIMULATION HELPERS
// =============================================================================

/**
 * Simulate transaction and extract new balance handle from account
 */
async function simulateAndGetHandle(
  connection: Connection,
  tx: anchor.web3.Transaction,
  accountPubkey: PublicKey,
  payer: Keypair
): Promise<bigint | null> {
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);

    const simulation = await connection.simulateTransaction(tx, undefined, [
      accountPubkey,
    ]);
    if (simulation.value.err) return null;

    if (simulation.value.accounts?.[0]?.data) {
      const data = Buffer.from(simulation.value.accounts[0].data[0], "base64");
      // Balance is at offset 72 (8 discriminator + 32 owner + 32 cvct_mint = 72)
      const amountBytes = data.slice(72, 88);
      let handle = BigInt(0);
      for (let i = 15; i >= 0; i--) {
        handle = handle * BigInt(256) + BigInt(amountBytes[i]);
      }
      return handle;
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// SETUP HELPERS
// =============================================================================

/**
 * Initialize the base CVCT infrastructure (mint, vault)
 */
async function initializeCvctInfrastructure(
  program: anchor.Program<CvctPayroll>,
  payer: Keypair,
  backingMint: PublicKey
): Promise<{ cvctMintPda: PublicKey; vaultPda: PublicKey; vaultTokenAccount: PublicKey }> {
  const [cvctMintPda] = deriveCvctMintPda(program.programId, payer.publicKey);
  const [vaultPda] = deriveVaultPda(program.programId, payer.publicKey);
  const vaultTokenAccount = await getAssociatedTokenAddress(
    backingMint,
    vaultPda,
    true
  );

  await program.methods
    .initializeCvctMint()
    .accounts({
      cvctMint: cvctMintPda,
      vault: vaultPda,
      backingMint,
      vaultTokenAccount,
      authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .rpc();

  return { cvctMintPda, vaultPda, vaultTokenAccount };
}

/**
 * Initialize a CVCT account for a user
 */
async function initializeCvctAccount(
  program: anchor.Program<CvctPayroll>,
  cvctMint: PublicKey,
  owner: Keypair
): Promise<PublicKey> {
  const [cvctAccountPda] = deriveCvctAccountPda(
    program.programId,
    cvctMint,
    owner.publicKey
  );

  await program.methods
    .initializeCvctAccount()
    .accounts({
      cvctAccount: cvctAccountPda,
      cvctMint,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .signers([owner])
    .rpc();

  return cvctAccountPda;
}

/**
 * Deposit backing tokens and mint CVCT
 */
async function depositAndMintCvct(
  program: anchor.Program<CvctPayroll>,
  connection: Connection,
  payer: Keypair,
  cvctMint: PublicKey,
  vault: PublicKey,
  cvctAccount: PublicKey,
  userTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  amount: number
): Promise<void> {
  // Simulate to get the new balance handle
  const txForSim = await program.methods
    .depositAndMint(new BN(amount))
    .accounts({
      cvctMint,
      vault,
      cvctAccount,
      user: payer.publicKey,
      userTokenAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .transaction();

  const newHandle = await simulateAndGetHandle(
    connection,
    txForSim,
    cvctAccount,
    payer
  );

  const remainingAccounts = [];
  if (newHandle) {
    const [allowancePda] = getAllowancePda(newHandle, payer.publicKey);
    remainingAccounts.push(
      { pubkey: allowancePda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }
    );
  }

  await program.methods
    .depositAndMint(new BN(amount))
    .accounts({
      cvctMint,
      vault,
      cvctAccount,
      user: payer.publicKey,
      userTokenAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .remainingAccounts(remainingAccounts)
    .rpc();
}

/**
 * Transfer CVCT between accounts
 */
async function transferCvct(
  program: anchor.Program<CvctPayroll>,
  connection: Connection,
  from: Keypair,
  cvctMint: PublicKey,
  fromCvctAccount: PublicKey,
  toCvctAccount: PublicKey,
  amount: bigint
): Promise<void> {
  const encryptedHex = await encryptValue(amount);

  await program.methods
    .transferCvct(hexToBuffer(encryptedHex))
    .accounts({
      cvctMint,
      fromCvctAccount,
      toCvctAccount,
      from: from.publicKey,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .signers([from])
    .rpc();
}

// =============================================================================
// PAYROLL SETUP HELPERS
// =============================================================================

/**
 * Initialize organization with treasury
 */
async function initializeOrganization(
  program: anchor.Program<CvctPayroll>,
  admin: Keypair,
  cvctMint: PublicKey,
  treasuryVault: PublicKey
): Promise<{ orgPda: PublicKey; orgTreasuryPda: PublicKey }> {
  const [orgPda] = deriveOrgPda(program.programId, admin.publicKey);
  const [orgTreasuryPda] = deriveOrgTreasuryPda(program.programId, orgPda);

  // Init org
  await program.methods
    .initOrg()
    .accounts({
      org: orgPda,
      cvctMint,
      treasuryVault,
      authority: admin.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  // Init org treasury
  await program.methods
    .initOrgTreasury()
    .accounts({
      org: orgPda,
      orgTreasury: orgTreasuryPda,
      cvctMint,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .rpc();

  return { orgPda, orgTreasuryPda };
}

/**
 * Create a payroll schedule
 */
async function createPayrollSchedule(
  program: anchor.Program<CvctPayroll>,
  admin: Keypair,
  org: PublicKey,
  interval: number
): Promise<PublicKey> {
  const [payrollPda] = derivePayrollPda(
    program.programId,
    org,
    admin.publicKey
  );

  await program.methods
    .createPayroll(new BN(interval))
    .accounts({
      org,
      payroll: payrollPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  return payrollPda;
}

/**
 * Add a member to payroll
 */
async function addMemberToPayroll(
  program: anchor.Program<CvctPayroll>,
  admin: Keypair,
  org: PublicKey,
  payroll: PublicKey,
  recipient: PublicKey,
  recipientCvctAccount: PublicKey,
  ratePerInterval: bigint
): Promise<PublicKey> {
  const [payrollMemberPda] = derivePayrollMemberPda(
    program.programId,
    payroll,
    recipient
  );

  const encryptedRate = await encryptValue(ratePerInterval);

  await program.methods
    .addPayrollMember(hexToBuffer(encryptedRate))
    .accounts({
      org,
      payroll,
      payrollMemberState: payrollMemberPda,
      recipient,
      recipientCvctAccount,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
    } as any)
    .rpc();

  return payrollMemberPda;
}

// =============================================================================
// ASSERTION HELPERS
// =============================================================================

/**
 * Assert that a transaction fails with expected error
 */
async function expectError(
  fn: () => Promise<any>,
  expectedError: string
): Promise<void> {
  try {
    await fn();
    expect.fail("Expected transaction to fail");
  } catch (error: any) {
    const errStr = error.toString().toLowerCase();
    expect(errStr).to.include(expectedError.toLowerCase());
  }
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe("cvct-payroll", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    anchor.AnchorProvider.env().wallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.CvctPayroll as anchor.Program<CvctPayroll>;
  
  // Main authority/payer
  let payer: Keypair;
  
  // SPL Token mint (backing asset)
  let backingMint: PublicKey;
  
  // CVCT PDAs
  let cvctMintPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultTokenAccount: PublicKey;
  
  // Organization PDAs
  let orgPda: PublicKey;
  let orgTreasuryPda: PublicKey;
  let payrollPda: PublicKey;
  
  // Admin's CVCT account (used as initial treasury vault reference)
  let adminCvctAccountPda: PublicKey;
  let adminTokenAccount: PublicKey;
  
  // Test members
  let member1: Keypair;
  let member1CvctAccountPda: PublicKey;
  let member1PayrollMemberPda: PublicKey;
  
  let member2: Keypair;
  let member2CvctAccountPda: PublicKey;
  
  // Unauthorized user for negative tests
  let unauthorized: Keypair;

  // ==========================================================================
  // BEFORE ALL - Setup infrastructure
  // ==========================================================================
  
  before(async () => {
    console.log("\n=== Setting up test infrastructure ===\n");
    
    payer = (provider.wallet as any).payer as Keypair;
    member1 = Keypair.generate();
    member2 = Keypair.generate();
    unauthorized = Keypair.generate();
    
    // Airdrop to test accounts
    await Promise.all([
      airdrop(connection, member1.publicKey),
      airdrop(connection, member2.publicKey),
      airdrop(connection, unauthorized.publicKey),
    ]);
    
    // Create backing mint
    backingMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    console.log("Backing mint:", backingMint.toBase58());
    
    // Create admin token account and mint backing tokens
    adminTokenAccount = await createAssociatedTokenAccount(
      connection,
      payer,
      backingMint,
      payer.publicKey
    );
    
    await mintTo(
      connection,
      payer,
      backingMint,
      adminTokenAccount,
      payer,
      DEPOSIT_AMOUNT * 2
    );
    console.log("Minted backing tokens to admin");
    
    // Initialize CVCT infrastructure
    const infra = await initializeCvctInfrastructure(
      program,
      payer,
      backingMint
    );
    cvctMintPda = infra.cvctMintPda;
    vaultPda = infra.vaultPda;
    vaultTokenAccount = infra.vaultTokenAccount;
    console.log("CVCT mint:", cvctMintPda.toBase58());
    console.log("Vault:", vaultPda.toBase58());
    
    // Initialize admin's CVCT account
    adminCvctAccountPda = await initializeCvctAccount(program, cvctMintPda, payer);
    console.log("Admin CVCT account:", adminCvctAccountPda.toBase58());
    
    // Deposit backing tokens to get CVCT
    await depositAndMintCvct(
      program,
      connection,
      payer,
      cvctMintPda,
      vaultPda,
      adminCvctAccountPda,
      adminTokenAccount,
      vaultTokenAccount,
      DEPOSIT_AMOUNT
    );
    console.log("Deposited backing tokens, minted CVCT");
    
    // Initialize member CVCT accounts
    member1CvctAccountPda = await initializeCvctAccount(program, cvctMintPda, member1);
    member2CvctAccountPda = await initializeCvctAccount(program, cvctMintPda, member2);
    console.log("Member1 CVCT account:", member1CvctAccountPda.toBase58());
    console.log("Member2 CVCT account:", member2CvctAccountPda.toBase58());
    
    console.log("\n=== Infrastructure setup complete ===\n");
  });

  // ==========================================================================
  // INIT ORG TESTS
  // ==========================================================================
  
  describe("init_org", () => {
    it("Should initialize organization successfully", async () => {
      const result = await initializeOrganization(
        program,
        payer,
        cvctMintPda,
        adminCvctAccountPda // Using admin's CVCT account as treasury vault
      );
      orgPda = result.orgPda;
      orgTreasuryPda = result.orgTreasuryPda;
      
      const org = await program.account.organization.fetch(orgPda);
      expect(org.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(org.cvctMint.toBase58()).to.equal(cvctMintPda.toBase58());
      
      console.log("Organization initialized:", orgPda.toBase58());
      console.log("Org Treasury:", orgTreasuryPda.toBase58());
    });

    it("Should fail to initialize org with non-existent CVCT mint", async () => {
      const fakeMint = Keypair.generate();
      const [fakeOrgPda] = deriveOrgPda(program.programId, unauthorized.publicKey);
      
      await expectError(
        async () => {
          await program.methods
            .initOrg()
            .accounts({
              org: fakeOrgPda,
              cvctMint: fakeMint.publicKey,
              treasuryVault: adminCvctAccountPda,
              authority: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "AccountNotInitialized"
      );
    });
  });

  // ==========================================================================
  // INIT ORG TREASURY TESTS
  // ==========================================================================
  
  describe("init_org_treasury", () => {
    it("Should initialize org treasury successfully (done in init_org)", async () => {
      // Already done in init_org test, verify state
      const treasury = await program.account.cvctAccount.fetch(orgTreasuryPda);
      expect(treasury.owner.toBase58()).to.equal(orgPda.toBase58());
      expect(treasury.cvctMint.toBase58()).to.equal(cvctMintPda.toBase58());
    });

    it("Should fail to initialize treasury with unauthorized admin", async () => {
      // Create a new org for this test to avoid conflicts
      const newAdmin = Keypair.generate();
      await airdrop(connection, newAdmin.publicKey);
      
      const newAdminCvctAccount = await initializeCvctAccount(program, cvctMintPda, newAdmin);
      
      const [newOrgPda] = deriveOrgPda(program.programId, newAdmin.publicKey);
      const [newTreasuryPda] = deriveOrgTreasuryPda(program.programId, newOrgPda);
      
      // Initialize org first
      await program.methods
        .initOrg()
        .accounts({
          org: newOrgPda,
          cvctMint: cvctMintPda,
          treasuryVault: newAdminCvctAccount,
          authority: newAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newAdmin])
        .rpc();
      
      // Try to init treasury with wrong admin
      await expectError(
        async () => {
          await program.methods
            .initOrgTreasury()
            .accounts({
              org: newOrgPda,
              orgTreasury: newTreasuryPda,
              cvctMint: cvctMintPda,
              admin: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
    });
  });

  // ==========================================================================
  // CREATE PAYROLL TESTS
  // ==========================================================================
  
  describe("create_payroll", () => {
    it("Should create payroll with valid interval", async () => {
      payrollPda = await createPayrollSchedule(
        program,
        payer,
        orgPda,
        PAYROLL_INTERVAL_SECONDS
      );
      
      const payroll = await program.account.payroll.fetch(payrollPda);
      expect(payroll.org.toBase58()).to.equal(orgPda.toBase58());
      expect(payroll.interval.toNumber()).to.equal(PAYROLL_INTERVAL_SECONDS);
      expect(payroll.active).to.be.true;
      
      console.log("Payroll created:", payrollPda.toBase58());
    });

    it("Should fail to create payroll with unauthorized admin", async () => {
      const [unauthorizedPayrollPda] = derivePayrollPda(
        program.programId,
        orgPda,
        unauthorized.publicKey
      );
      
      await expectError(
        async () => {
          await program.methods
            .createPayroll(new BN(PAYROLL_INTERVAL_SECONDS))
            .accounts({
              org: orgPda,
              payroll: unauthorizedPayrollPda,
              admin: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
    });
  });

  // ==========================================================================
  // ADD PAYROLL MEMBER TESTS
  // ==========================================================================
  
  describe("add_payroll_member", () => {
    it("Should add member with encrypted rate", async () => {
      member1PayrollMemberPda = await addMemberToPayroll(
        program,
        payer,
        orgPda,
        payrollPda,
        member1.publicKey,
        member1CvctAccountPda,
        RATE_PER_INTERVAL
      );
      
      const member = await program.account.payrollMember.fetch(member1PayrollMemberPda);
      expect(member.payroll.toBase58()).to.equal(payrollPda.toBase58());
      expect(member.cvctWallet.toBase58()).to.equal(member1CvctAccountPda.toBase58());
      expect(member.active).to.be.true;
      expect(member.lastPaid.toNumber()).to.equal(0);
      
      console.log("Member1 added to payroll:", member1PayrollMemberPda.toBase58());
    });

    it("Should fail to add member with unauthorized admin", async () => {
      const [member2PayrollMemberPda] = derivePayrollMemberPda(
        program.programId,
        payrollPda,
        member2.publicKey
      );
      
      const encryptedRate = await encryptValue(RATE_PER_INTERVAL);
      
      await expectError(
        async () => {
          await program.methods
            .addPayrollMember(hexToBuffer(encryptedRate))
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              payrollMemberState: member2PayrollMemberPda,
              recipient: member2.publicKey,
              recipientCvctAccount: member2CvctAccountPda,
              admin: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
    });
  });

  // ==========================================================================
  // UPDATE PAYROLL MEMBER TESTS
  // ==========================================================================
  
  describe("update_payroll_member", () => {
    it("Should update member rate and status", async () => {
      const newRate = BigInt(2_000_000_000); // Double the rate
      const encryptedRate = await encryptValue(newRate);
      
      await program.methods
        .updatePayrollMember(hexToBuffer(encryptedRate), true)
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          payrollMemberState: member1PayrollMemberPda,
          admin: payer.publicKey,
          systemProgram: SystemProgram.programId,
          incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        } as any)
        .rpc();
      
      const member = await program.account.payrollMember.fetch(member1PayrollMemberPda);
      expect(member.active).to.be.true;
      // Rate is encrypted, can't verify directly
      
      console.log("Member1 rate updated");
    });

    it("Should fail to update member with unauthorized admin", async () => {
      const newRate = BigInt(1_000_000_000);
      const encryptedRate = await encryptValue(newRate);
      
      await expectError(
        async () => {
          await program.methods
            .updatePayrollMember(hexToBuffer(encryptedRate), true)
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              payrollMemberState: member1PayrollMemberPda,
              admin: unauthorized.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
    });
  });

  // ==========================================================================
  // PAUSE PAYROLL TESTS
  // ==========================================================================
  
  describe("pause_payroll", () => {
    it("Should pause active payroll", async () => {
      await program.methods
        .pausePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      const payroll = await program.account.payroll.fetch(payrollPda);
      expect(payroll.active).to.be.false;
      
      console.log("Payroll paused");
    });

    it("Should fail to pause with unauthorized admin", async () => {
      // Resume first for this test
      await program.methods
        .resumePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      await expectError(
        async () => {
          await program.methods
            .pausePayroll()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              admin: unauthorized.publicKey,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
    });
  });

  // ==========================================================================
  // RESUME PAYROLL TESTS
  // ==========================================================================
  
  describe("resume_payroll", () => {
    it("Should resume paused payroll", async () => {
      // Pause first
      await program.methods
        .pausePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      // Now resume
      await program.methods
        .resumePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      const payroll = await program.account.payroll.fetch(payrollPda);
      expect(payroll.active).to.be.true;
      
      console.log("Payroll resumed");
    });

    it("Should fail to resume with unauthorized admin", async () => {
      // Pause first
      await program.methods
        .pausePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      await expectError(
        async () => {
          await program.methods
            .resumePayroll()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              admin: unauthorized.publicKey,
            } as any)
            .signers([unauthorized])
            .rpc();
        },
        "unauthorized"
      );
      
      // Resume for subsequent tests
      await program.methods
        .resumePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
    });
  });

  // ==========================================================================
  // RUN PAYROLL FOR MEMBER TESTS
  // ==========================================================================
  
  describe("run_payroll_for_member", () => {
    before(async () => {
      // Fund the org treasury with CVCT for payroll
      console.log("\nFunding org treasury for payroll tests...");
      
      // Transfer CVCT from admin to org treasury
      await transferCvct(
        program,
        connection,
        payer,
        cvctMintPda,
        adminCvctAccountPda,
        orgTreasuryPda,
        BigInt(50_000_000_000) // 50 tokens
      );
      
      console.log("Org treasury funded");
    });

    it("Should run payroll and pay member", async () => {
      // Update the org's treasury vault reference to use orgTreasuryPda
      // Note: This requires the org to point to the correct treasury
      
      await program.methods
        .runPayrollForMember()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          payrollMemberState: member1PayrollMemberPda,
          orgTreasury: orgTreasuryPda,
          memberCvctAccount: member1CvctAccountPda,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
          incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        } as any)
        .rpc();
      
      const member = await program.account.payrollMember.fetch(member1PayrollMemberPda);
      expect(member.lastPaid.toNumber()).to.be.greaterThan(0);
      
      console.log("Payroll executed for member1");
    });

    it("Should fail to run payroll when payroll is paused", async () => {
      // Pause payroll
      await program.methods
        .pausePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      await expectError(
        async () => {
          await program.methods
            .runPayrollForMember()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              payrollMemberState: member1PayrollMemberPda,
              orgTreasury: orgTreasuryPda,
              memberCvctAccount: member1CvctAccountPda,
              payer: payer.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .rpc();
        },
        "PayrollNotActive"
      );
      
      // Resume for subsequent tests
      await program.methods
        .resumePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
    });

    it("Should fail to run payroll when member is inactive", async () => {
      // Deactivate member
      const encryptedRate = await encryptValue(RATE_PER_INTERVAL);
      await program.methods
        .updatePayrollMember(hexToBuffer(encryptedRate), false)
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          payrollMemberState: member1PayrollMemberPda,
          admin: payer.publicKey,
          systemProgram: SystemProgram.programId,
          incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        } as any)
        .rpc();
      
      await expectError(
        async () => {
          await program.methods
            .runPayrollForMember()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              payrollMemberState: member1PayrollMemberPda,
              orgTreasury: orgTreasuryPda,
              memberCvctAccount: member1CvctAccountPda,
              payer: payer.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .rpc();
        },
        "MemberNotActive"
      );
      
      // Reactivate member
      await program.methods
        .updatePayrollMember(hexToBuffer(encryptedRate), true)
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          payrollMemberState: member1PayrollMemberPda,
          admin: payer.publicKey,
          systemProgram: SystemProgram.programId,
          incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        } as any)
        .rpc();
    });

    it("Should fail to run payroll when not due", async () => {
      // Payroll was just run, shouldn't be due again immediately
      await expectError(
        async () => {
          await program.methods
            .runPayrollForMember()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              payrollMemberState: member1PayrollMemberPda,
              orgTreasury: orgTreasuryPda,
              memberCvctAccount: member1CvctAccountPda,
              payer: payer.publicKey,
              systemProgram: SystemProgram.programId,
              incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            } as any)
            .rpc();
        },
        "PayrollNotDue"
      );
    });
  });

  // ==========================================================================
  // CLOSE PAYROLL TESTS
  // ==========================================================================
  
  describe("close_payroll", () => {
    let tempPayrollPda: PublicKey;
    
    before(async () => {
      // Create a temporary payroll for close tests
      const tempAdmin = Keypair.generate();
      await airdrop(connection, tempAdmin.publicKey);
      
      const tempCvctAccount = await initializeCvctAccount(program, cvctMintPda, tempAdmin);
      
      const [tempOrgPda] = deriveOrgPda(program.programId, tempAdmin.publicKey);
      
      await program.methods
        .initOrg()
        .accounts({
          org: tempOrgPda,
          cvctMint: cvctMintPda,
          treasuryVault: tempCvctAccount,
          authority: tempAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([tempAdmin])
        .rpc();
      
      [tempPayrollPda] = derivePayrollPda(
        program.programId,
        tempOrgPda,
        tempAdmin.publicKey
      );
      
      await program.methods
        .createPayroll(new BN(PAYROLL_INTERVAL_SECONDS))
        .accounts({
          org: tempOrgPda,
          payroll: tempPayrollPda,
          admin: tempAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([tempAdmin])
        .rpc();
      
      // Pause it for close tests
      await program.methods
        .pausePayroll()
        .accounts({
          org: tempOrgPda,
          payroll: tempPayrollPda,
          admin: tempAdmin.publicKey,
        } as any)
        .signers([tempAdmin])
        .rpc();
    });

    it("Should fail to close payroll when not paused", async () => {
      // Ensure main payroll is active
      const payroll = await program.account.payroll.fetch(payrollPda);
      if (!payroll.active) {
        await program.methods
          .resumePayroll()
          .accounts({
            org: orgPda,
            payroll: payrollPda,
            admin: payer.publicKey,
          } as any)
          .rpc();
      }
      
      await expectError(
        async () => {
          await program.methods
            .closePayroll()
            .accounts({
              org: orgPda,
              payroll: payrollPda,
              admin: payer.publicKey,
            } as any)
            .rpc();
        },
        "MustPauseFirst"
      );
    });

    it("Should close paused payroll", async () => {
      // Pause payroll first
      await program.methods
        .pausePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      // Now close
      await program.methods
        .closePayroll()
        .accounts({
          org: orgPda,
          payroll: payrollPda,
          admin: payer.publicKey,
        } as any)
        .rpc();
      
      // Verify payroll account is closed
      try {
        await program.account.payroll.fetch(payrollPda);
        expect.fail("Payroll account should be closed");
      } catch (error: any) {
        expect(error.message).to.include("Account does not exist");
      }
      
      console.log("Payroll closed successfully");
    });
  });

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  
  describe("Summary", () => {
    it("Should display final state", async () => {
      console.log("\n=== Final Test State ===\n");
      
      const org = await program.account.organization.fetch(orgPda);
      console.log("Organization Authority:", org.authority.toBase58());
      
      const treasury = await program.account.cvctAccount.fetch(orgTreasuryPda);
      const treasuryHandle = extractHandle(treasury.balance);
      console.log("Treasury Balance Handle:", treasuryHandle.toString());
      
      const member = await program.account.payrollMember.fetch(member1PayrollMemberPda);
      console.log("Member1 Last Paid:", new Date(member.lastPaid.toNumber() * 1000).toISOString());
      console.log("Member1 Active:", member.active);
      
      const memberAccount = await program.account.cvctAccount.fetch(member1CvctAccountPda);
      const memberHandle = extractHandle(memberAccount.balance);
      console.log("Member1 Balance Handle:", memberHandle.toString());
      
      console.log("\n=== Tests Complete ===\n");
    });
  });
});
