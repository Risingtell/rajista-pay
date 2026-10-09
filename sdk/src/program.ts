// A small hand-written client for the till program: addresses, instructions
// and account/event decoding. Written by hand, without the Anchor TS client,
// so a till running in a phone browser pulls in as little code as possible.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

/** Set once the program is deployed; overridable for tests and other clusters. */
export const TILL_PROGRAM_ID = new PublicKey("4y78XTmZk9GERsxhP4ezpnfuqX2iZh3Dq3aKZYk3XtQq");

export const USDC_MINT = {
  mainnet: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  devnet: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
} as const;

export const USDC_DECIMALS = 6;

/** The classic SPL Token program, which USDC lives under. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Create a wallet's associated token account if it does not exist yet; a no-op if it does. */
export function createAssociatedTokenAccountIdempotentIx(a: {
  payer: PublicKey;
  wallet: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: a.payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(a.mint, a.wallet), isSigner: false, isWritable: true },
      { pubkey: a.wallet, isSigner: false, isWritable: false },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** A wallet's associated token account for a mint (the address wallets use by default). */
export function associatedTokenAddress(mint: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [wallet.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

const enc = new TextEncoder();
const disc = (s: string) => sha256(enc.encode(s)).slice(0, 8);

const IX = {
  registerShop: disc("global:register_shop"),
  setPayout: disc("global:set_payout"),
  addTill: disc("global:add_till"),
  removeTill: disc("global:remove_till"),
  postBill: disc("global:post_bill"),
  payBill: disc("global:pay_bill"),
  closeBill: disc("global:close_bill"),
};

const ACCOUNT = {
  Shop: disc("account:Shop"),
  Till: disc("account:Till"),
  Bill: disc("account:Bill"),
};

const EVENT = {
  BillPaid: disc("event:BillPaid"),
  BillPosted: disc("event:BillPosted"),
};

// ---------- addresses ----------

export function shopAddress(owner: PublicKey, shopId: Uint8Array, programId = TILL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("shop"), owner.toBytes(), id16(shopId)], programId)[0];
}

export function tillAddress(shop: PublicKey, tillKey: PublicKey, programId = TILL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("till"), shop.toBytes(), tillKey.toBytes()], programId)[0];
}

export function billAddress(shop: PublicKey, saleId: Uint8Array, programId = TILL_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("bill"), shop.toBytes(), id16(saleId)], programId)[0];
}

// ---------- instructions ----------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export function registerShopIx(a: {
  owner: PublicKey;
  payer: PublicKey;
  shopId: Uint8Array;
  mint: PublicKey;
  payout: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = a.programId ?? TILL_PROGRAM_ID;
  const shop = shopAddress(a.owner, a.shopId, programId);
  return new TransactionInstruction({
    programId,
    keys: [r(a.owner, true), w(a.payer, true), w(shop), r(a.mint), r(a.payout), r(SystemProgram.programId)],
    data: concat(IX.registerShop, id16(a.shopId)),
  });
}

export function setPayoutIx(a: { owner: PublicKey; shop: PublicKey; payout: PublicKey; programId?: PublicKey }) {
  return new TransactionInstruction({
    programId: a.programId ?? TILL_PROGRAM_ID,
    keys: [r(a.owner, true), w(a.shop), r(a.payout)],
    data: Buffer.from(IX.setPayout),
  });
}

export function addTillIx(a: {
  owner: PublicKey;
  payer: PublicKey;
  shop: PublicKey;
  tillKey: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = a.programId ?? TILL_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      r(a.owner, true),
      w(a.payer, true),
      r(a.shop),
      w(tillAddress(a.shop, a.tillKey, programId)),
      r(SystemProgram.programId),
    ],
    data: concat(IX.addTill, a.tillKey.toBytes()),
  });
}

export function removeTillIx(a: { owner: PublicKey; shop: PublicKey; tillKey: PublicKey; programId?: PublicKey }) {
  const programId = a.programId ?? TILL_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [w(a.owner, true), r(a.shop), w(tillAddress(a.shop, a.tillKey, programId))],
    data: Buffer.from(IX.removeTill),
  });
}

export function postBillIx(a: {
  tillKey: PublicKey;
  payer: PublicKey;
  shop: PublicKey;
  saleId: Uint8Array;
  amount: bigint;
  nairaKobo: bigint;
  rateKobo: bigint;
  ttlSecs: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = a.programId ?? TILL_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      r(a.tillKey, true),
      w(a.payer, true),
      r(a.shop),
      r(tillAddress(a.shop, a.tillKey, programId)),
      w(billAddress(a.shop, a.saleId, programId)),
      r(SystemProgram.programId),
    ],
    data: concat(IX.postBill, id16(a.saleId), u64(a.amount), u64(a.nairaKobo), u64(a.rateKobo), i64(BigInt(a.ttlSecs))),
  });
}

export function payBillIx(a: {
  customer: PublicKey;
  shop: PublicKey;
  bill: PublicKey;
  mint: PublicKey;
  payout: PublicKey;
  /** The customer's USDC account. Defaults to their associated token account. */
  from?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const from = a.from ?? associatedTokenAddress(a.mint, a.customer);
  return new TransactionInstruction({
    programId: a.programId ?? TILL_PROGRAM_ID,
    keys: [r(a.customer, true), w(a.shop), w(a.bill), r(a.mint), w(from), w(a.payout), r(TOKEN_PROGRAM_ID)],
    data: Buffer.from(IX.payBill),
  });
}

export function closeBillIx(a: { closer: PublicKey; bill: PublicKey; rentPayer: PublicKey; programId?: PublicKey }) {
  return new TransactionInstruction({
    programId: a.programId ?? TILL_PROGRAM_ID,
    keys: [r(a.closer, true), w(a.bill), w(a.rentPayer)],
    data: Buffer.from(IX.closeBill),
  });
}

// ---------- decoding ----------

export interface ShopAccount {
  owner: PublicKey;
  shopId: Uint8Array;
  mint: PublicKey;
  payout: PublicKey;
  billsPaid: bigint;
  totalPaid: bigint;
}

export interface BillAccount {
  shop: PublicKey;
  till: PublicKey;
  saleId: Uint8Array;
  amount: bigint;
  nairaKobo: bigint;
  rateKobo: bigint;
  createdAt: number;
  expiresAt: number;
  paid: boolean;
  payer: PublicKey;
  paidAt: number;
  rentPayer: PublicKey;
}

export interface BillPaidEvent {
  shop: PublicKey;
  bill: PublicKey;
  till: PublicKey;
  saleId: Uint8Array;
  amount: bigint;
  nairaKobo: bigint;
  rateKobo: bigint;
  payer: PublicKey;
  payout: PublicKey;
  paidAt: number;
}

export function decodeShop(data: Uint8Array): ShopAccount {
  const c = new Cursor(data, ACCOUNT.Shop, "Shop");
  return {
    owner: c.key(),
    shopId: c.bytes(16),
    mint: c.key(),
    payout: c.key(),
    billsPaid: c.u64(),
    totalPaid: c.u64(),
  };
}

export function decodeBill(data: Uint8Array): BillAccount {
  const c = new Cursor(data, ACCOUNT.Bill, "Bill");
  return {
    shop: c.key(),
    till: c.key(),
    saleId: c.bytes(16),
    amount: c.u64(),
    nairaKobo: c.u64(),
    rateKobo: c.u64(),
    createdAt: Number(c.i64()),
    expiresAt: Number(c.i64()),
    paid: c.bool(),
    payer: c.key(),
    paidAt: Number(c.i64()),
    rentPayer: c.key(),
  };
}

/** Pull BillPaid events out of a transaction's log messages. */
export function billPaidEventsFromLogs(logs: readonly string[]): BillPaidEvent[] {
  const out: BillPaidEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = base64ToBytes(line.slice("Program data: ".length));
    if (raw.length < 8 || !eq(raw.subarray(0, 8), EVENT.BillPaid)) continue;
    const c = new Cursor(raw, EVENT.BillPaid, "BillPaid");
    out.push({
      shop: c.key(),
      bill: c.key(),
      till: c.key(),
      saleId: c.bytes(16),
      amount: c.u64(),
      nairaKobo: c.u64(),
      rateKobo: c.u64(),
      payer: c.key(),
      payout: c.key(),
      paidAt: Number(c.i64()),
    });
  }
  return out;
}

// ---------- helpers ----------

/** A 16-byte id. Rajista's ULIDs are exactly 16 bytes. */
export function id16(b: Uint8Array): Uint8Array {
  if (b.length !== 16) throw new Error("Ids must be exactly 16 bytes");
  return b;
}

/** Crockford base32 ULID string -> 16 bytes, so a Rajista sale id maps one to one. */
export function ulidToBytes(ulid: string): Uint8Array {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const s = ulid.toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) throw new Error("Not a ULID");
  let n = 0n;
  for (const ch of s) n = (n << 5n) | BigInt(A.indexOf(ch));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function bytesToUlid(b: Uint8Array): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0n;
  for (const x of id16(b)) n = (n << 8n) | BigInt(x);
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = A[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

class Cursor {
  private o = 8;
  private v: DataView;
  constructor(private d: Uint8Array, expect: Uint8Array, name: string) {
    if (d.length < 8 || !eq(d.subarray(0, 8), expect)) throw new Error(`Not a ${name} account`);
    this.v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  key() {
    const k = new PublicKey(this.d.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  bytes(n: number) {
    const b = this.d.slice(this.o, this.o + n);
    this.o += n;
    return b;
  }
  u64() {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return x;
  }
  bool() {
    return this.d[this.o++] === 1;
  }
}

function u64(x: bigint): Uint8Array {
  if (x < 0n || x > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
}

function i64(x: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, x, true);
  return b;
}

function concat(...parts: Uint8Array[]): Buffer {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return Buffer.from(out);
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
