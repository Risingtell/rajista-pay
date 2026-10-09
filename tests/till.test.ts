// The till program, run for real in LiteSVM and driven only through the
// rajista-pay SDK, the same way a Rajista till and a customer's wallet use it.
// Every test is named after the claim it defends.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  AccountLayout,
  ACCOUNT_SIZE,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  TILL_PROGRAM_ID,
  USDC_MINT,
  addTillIx,
  associatedTokenAddress,
  bytesToUlid,
  billAddress,
  billPaidEventsFromLogs,
  closeBillIx,
  decodeBill,
  decodeShop,
  koboToUsdcMicro,
  payBillIx,
  postBillIx,
  registerShopIx,
  removeTillIx,
  setPayoutIx,
  shopAddress,
  tillAddress,
  ulidToBytes,
} from "../sdk/src/index.js";

const SO = fileURLToPath(new URL("../target/deploy/till.so", import.meta.url));
if (!existsSync(SO)) throw new Error(`Build the program first (anchor build): ${SO} is missing`);
const PROGRAM = readFileSync(SO);

const USDC = USDC_MINT.devnet;
const RATE = 135_100n; // N1,351.00 per USDC, in kobo
const PRICE = 1_000_000n; // N10,000.00, in kobo
const AMOUNT = koboToUsdcMicro(PRICE, RATE); // 7.401925 USDC

let svm: LiteSVM;
let owner: Keypair;
let relay: Keypair; // pays fees and rent, as the Rajista relay does
let till: Keypair;
let customer: Keypair;
let shopId: Uint8Array;
let shop: PublicKey;
let payout: PublicKey;
let customerUsdc: PublicKey;

beforeEach(() => {
  svm = new LiteSVM();
  svm.addProgram(address(TILL_PROGRAM_ID.toBase58()), PROGRAM);
  owner = Keypair.generate();
  relay = Keypair.generate();
  till = Keypair.generate();
  customer = Keypair.generate();
  for (const k of [owner, relay, customer]) svm.airdrop(address(k.publicKey.toBase58()), lamports(10_000_000_000n));

  setMint(USDC);
  payout = getAssociatedTokenAddressSync(USDC, owner.publicKey);
  setTokenAccount(payout, USDC, owner.publicKey, 0n);
  customerUsdc = getAssociatedTokenAddressSync(USDC, customer.publicKey);
  setTokenAccount(customerUsdc, USDC, customer.publicKey, 50_000_000n);

  shopId = ulidToBytes("01K6GZ8Y3T2X9V4N7Q1M5R8B2C");
  shop = shopAddress(owner.publicKey, shopId);
  ok(send([registerShopIx({ owner: owner.publicKey, payer: relay.publicKey, shopId, mint: USDC, payout })], relay, owner));
  ok(send([addTillIx({ owner: owner.publicKey, payer: relay.publicKey, shop, tillKey: till.publicKey })], relay, owner));
});

describe("the SDK", () => {
  it("derives the same customer token account as spl-token", () => {
    for (let i = 0; i < 5; i++) {
      const w = Keypair.generate().publicKey;
      expect(associatedTokenAddress(USDC, w).equals(getAssociatedTokenAddressSync(USDC, w))).toBe(true);
    }
  });

  it("maps a Rajista ULID sale id to 16 bytes and back", () => {
    const id = "01K6GZ8Y3T2X9V4N7Q1M5R8B2C";
    expect(bytesToUlid(ulidToBytes(id))).toBe(id);
  });
});

describe("a shop", () => {
  it("is registered with the owner, USDC and the owner's payout account", () => {
    const s = decodeShop(account(shop));
    expect(s.owner.equals(owner.publicKey)).toBe(true);
    expect(s.mint.equals(USDC)).toBe(true);
    expect(s.payout.equals(payout)).toBe(true);
    expect(s.billsPaid).toBe(0n);
  });

  it("rejects_non_usdc_mint at registration", () => {
    const fake = Keypair.generate().publicKey;
    setMint(fake);
    const acct = Keypair.generate().publicKey;
    setTokenAccount(acct, fake, owner.publicKey, 0n);
    const id = ulidToBytes("01K6GZ8Y3T2X9V4N7Q1M5R8B2D");
    const r = send([registerShopIx({ owner: owner.publicKey, payer: relay.publicKey, shopId: id, mint: fake, payout: acct })], relay, owner);
    expectError(r, "WrongMint");
  });
});

describe("paying a bill", () => {
  it("pays_exact_amount_to_owner_payout and records the sale", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000A1");
    ok(postBill(saleId));
    const r = ok(pay(saleId));

    expect(balance(customerUsdc)).toBe(50_000_000n - AMOUNT);
    expect(balance(payout)).toBe(AMOUNT);

    const bill = decodeBill(account(billAddress(shop, saleId)));
    expect(bill.paid).toBe(true);
    expect(bill.payer.equals(customer.publicKey)).toBe(true);
    expect(bill.nairaKobo).toBe(PRICE);
    expect(bill.rateKobo).toBe(RATE);

    const s = decodeShop(account(shop));
    expect(s.billsPaid).toBe(1n);
    expect(s.totalPaid).toBe(AMOUNT);

    const [ev] = billPaidEventsFromLogs(r.logs());
    expect(ev.amount).toBe(AMOUNT);
    expect(ev.nairaKobo).toBe(PRICE);
    expect(ev.payout.equals(payout)).toBe(true);
    expect(Buffer.from(ev.saleId)).toEqual(Buffer.from(saleId));
  });

  it("rejects_second_payment", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000A2");
    ok(postBill(saleId));
    ok(pay(saleId));
    expectError(pay(saleId), "BillAlreadyPaid");
    expect(balance(payout)).toBe(AMOUNT);
  });

  it("rejects_redirected_payout", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000A3");
    ok(postBill(saleId));
    const cashier = Keypair.generate().publicKey;
    const cashierUsdc = getAssociatedTokenAddressSync(USDC, cashier);
    setTokenAccount(cashierUsdc, USDC, cashier, 0n);
    expectError(pay(saleId, { payout: cashierUsdc }), "WrongPayout");
    expect(balance(cashierUsdc)).toBe(0n);
  });

  it("rejects_expired_bill", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000A4");
    ok(postBill(saleId, { ttlSecs: 600 }));
    warp(601);
    expectError(pay(saleId), "BillExpired");
  });

  it("rejects_other_token_from_customer", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000A5");
    ok(postBill(saleId));
    const fake = Keypair.generate().publicKey;
    setMint(fake);
    const fakeAcct = Keypair.generate().publicKey;
    setTokenAccount(fakeAcct, fake, customer.publicKey, 50_000_000n);
    expectError(pay(saleId, { from: fakeAcct }), "WrongMint");
  });
});

describe("posting a bill", () => {
  it("rejects_unregistered_till", () => {
    const stranger = Keypair.generate();
    const r = send(
      [postBillIx({ tillKey: stranger.publicKey, payer: relay.publicKey, shop, saleId: ulidToBytes("01K6H0000000000000000000B1"), amount: AMOUNT, nairaKobo: PRICE, rateKobo: RATE, ttlSecs: 600 })],
      relay,
      stranger,
    );
    expectError(r, "TillNotRegistered");
  });

  it("rejects_removed_till", () => {
    ok(send([removeTillIx({ owner: owner.publicKey, shop, tillKey: till.publicKey })], relay, owner));
    expect(svm.getAccount(address(tillAddress(shop, till.publicKey).toBase58())).exists).toBe(false);
    expectError(postBill(ulidToBytes("01K6H0000000000000000000B2")), "TillNotRegistered");
  });

  it("rejects_amount_not_matching_naira_price", () => {
    expectError(postBill(ulidToBytes("01K6H0000000000000000000B3"), { amount: AMOUNT - 1n }), "AmountMismatch");
  });

  it("rejects_bill_open_longer_than_15_minutes", () => {
    expectError(postBill(ulidToBytes("01K6H0000000000000000000B4"), { ttlSecs: 901 }), "BadTtl");
  });

  it("rejects_same_sale_billed_twice", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000B5");
    ok(postBill(saleId));
    const r = postBill(saleId);
    expect(r).toBeInstanceOf(FailedTransactionMetadata);
    expect(logs(r).join("\n")).toMatch(/already in use/);
  });
});

describe("the owner", () => {
  it("rejects_payout_change_by_non_owner", () => {
    const cashier = Keypair.generate();
    svm.airdrop(address(cashier.publicKey.toBase58()), lamports(1_000_000_000n));
    const theirs = getAssociatedTokenAddressSync(USDC, cashier.publicKey);
    setTokenAccount(theirs, USDC, cashier.publicKey, 0n);
    expectError(send([setPayoutIx({ owner: cashier.publicKey, shop, payout: theirs })], cashier), "NotOwner");
  });

  it("changes the payout and later payments follow it", () => {
    const savings = Keypair.generate().publicKey;
    setTokenAccount(savings, USDC, owner.publicKey, 0n);
    ok(send([setPayoutIx({ owner: owner.publicKey, shop, payout: savings })], relay, owner));
    const saleId = ulidToBytes("01K6H0000000000000000000C1");
    ok(postBill(saleId));
    ok(pay(saleId, { payout: savings }));
    expect(balance(savings)).toBe(AMOUNT);
    const next = ulidToBytes("01K6H0000000000000000000C2");
    ok(postBill(next));
    expectError(pay(next, { payout }), "WrongPayout");
  });
});

describe("closing a bill", () => {
  it("rejects_closing_open_bill", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000D1");
    ok(postBill(saleId));
    const bill = billAddress(shop, saleId);
    expectError(send([closeBillIx({ closer: relay.publicKey, bill, rentPayer: relay.publicKey })], relay), "BillStillOpen");
  });

  it("returns rent to the payer after payment, and the record survives in the shop totals", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000D2");
    ok(postBill(saleId));
    ok(pay(saleId));
    const bill = billAddress(shop, saleId);
    const rent = svm.getBalance(address(bill.toBase58()))!;
    const before = svm.getBalance(address(relay.publicKey.toBase58()))!;
    const closer = Keypair.generate();
    svm.airdrop(address(closer.publicKey.toBase58()), lamports(1_000_000_000n));
    ok(send([closeBillIx({ closer: closer.publicKey, bill, rentPayer: relay.publicKey })], closer));
    expect(svm.getBalance(address(relay.publicKey.toBase58()))).toBe(before + rent);
    expect(svm.getAccount(address(bill.toBase58())).exists).toBe(false);
    expect(decodeShop(account(shop)).billsPaid).toBe(1n);
  });

  it("rejects_rent_to_anyone_else", () => {
    const saleId = ulidToBytes("01K6H0000000000000000000D3");
    ok(postBill(saleId));
    warp(901);
    const thief = Keypair.generate();
    svm.airdrop(address(thief.publicKey.toBase58()), lamports(1_000_000_000n));
    const bill = billAddress(shop, saleId);
    expectError(send([closeBillIx({ closer: thief.publicKey, bill, rentPayer: thief.publicKey })], thief), "WrongRentPayer");
  });
});

// ---------- helpers ----------

type Result = TransactionMetadata | FailedTransactionMetadata;

function postBill(saleId: Uint8Array, o: { amount?: bigint; ttlSecs?: number } = {}): Result {
  return send(
    [
      postBillIx({
        tillKey: till.publicKey,
        payer: relay.publicKey,
        shop,
        saleId,
        amount: o.amount ?? AMOUNT,
        nairaKobo: PRICE,
        rateKobo: RATE,
        ttlSecs: o.ttlSecs ?? 600,
      }),
    ],
    relay,
    till,
  );
}

function pay(saleId: Uint8Array, o: { payout?: PublicKey; from?: PublicKey } = {}): Result {
  // The relay is the fee payer, so the customer needs no SOL: only USDC.
  return send(
    [
      payBillIx({
        customer: customer.publicKey,
        shop,
        bill: billAddress(shop, saleId),
        mint: USDC,
        payout: o.payout ?? payout,
        from: o.from,
      }),
    ],
    relay,
    customer,
  );
}

function send(ixs: TransactionInstruction[], feePayer: Keypair, ...signers: Keypair[]): Result {
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey)));
  const r = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  svm.expireBlockhash();
  return r;
}

function ok(r: Result): TransactionMetadata {
  if (r instanceof FailedTransactionMetadata) throw new Error(`Transaction failed:\n${r.meta().prettyLogs()}`);
  return r;
}

function logs(r: Result): string[] {
  return r instanceof FailedTransactionMetadata ? r.meta().logs() : r.logs();
}

function expectError(r: Result, code: string): void {
  expect(r, `expected ${code}`).toBeInstanceOf(FailedTransactionMetadata);
  expect(logs(r).join("\n")).toContain(`Error Code: ${code}.`);
}

function warp(seconds: number): void {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)));
}

function account(key: PublicKey): Uint8Array {
  const a = svm.getAccount(address(key.toBase58()));
  if (!a.exists) throw new Error(`No account at ${key.toBase58()}`);
  return a.data;
}

function balance(tokenAccount: PublicKey): bigint {
  return AccountLayout.decode(account(tokenAccount)).amount;
}

function setMint(mint: PublicKey): void {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: Keypair.generate().publicKey,
      supply: 1_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  setRaw(mint, data, TOKEN_PROGRAM_ID);
}

function setTokenAccount(at: PublicKey, mint: PublicKey, holder: PublicKey, amount: bigint): void {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: holder,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  setRaw(at, data, TOKEN_PROGRAM_ID);
}

function setRaw(at: PublicKey, data: Buffer, programOwner: PublicKey): void {
  svm.setAccount({
    address: address(at.toBase58()),
    data: new Uint8Array(data),
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: address(programOwner.toBase58()),
    space: BigInt(data.length),
  });
}
