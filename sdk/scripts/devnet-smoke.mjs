#!/usr/bin/env node
// End to end on devnet, with real transactions:
//   register a shop -> register a till -> quote the live naira rate ->
//   post a bill -> customer pays it (relay pays the fee) -> verify from chain,
// then the attacks a judge will ask about, each landed on-chain on purpose so
// its refusal has an explorer link: pay twice, redirect the payout, pay an
// expired bill, post from an unregistered till.
//
// Usage: node scripts/devnet-smoke.mjs --owner <keypair.json> [--naira 1500]
// The owner keypair also acts as the relay (fee payer). The till and customer
// keypairs are created under ../keys/ (gitignored) on first run. The customer
// needs devnet USDC: https://faucet.circle.com (Solana Devnet).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as rp from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.owner) {
  console.error("Usage: node scripts/devnet-smoke.mjs --owner <keypair.json> [--naira 1500]");
  process.exit(2);
}

const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
const mainnet = new Connection(process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const USDC = rp.USDC_MINT.devnet;
const ex = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const owner = loadKey(args.owner);
const relay = owner;
mkdirSync(join(root, "keys"), { recursive: true });
const till = keyAt(join(root, "keys", "till-devnet.json"));
const customer = keyAt(join(root, "keys", "customer-devnet.json"));

const shopId = createHash("sha256").update("rajista-pay devnet demo shop").digest().subarray(0, 16);
const shop = rp.shopAddress(owner.publicKey, shopId);
const payout = rp.associatedTokenAddress(USDC, owner.publicKey);
const proof = { cluster: "devnet", program: rp.TILL_PROGRAM_ID.toBase58(), shop: shop.toBase58(), payout: payout.toBase58(), steps: [] };

console.log(`Owner/relay ${owner.publicKey.toBase58()}`);
console.log(`Till        ${till.publicKey.toBase58()}`);
console.log(`Customer    ${customer.publicKey.toBase58()}`);
console.log(`Shop        ${shop.toBase58()}`);

// 1. Shop and till, once.
if (!(await conn.getAccountInfo(shop))) {
  const sig = await send([
    rp.createAssociatedTokenAccountIdempotentIx({ payer: relay.publicKey, wallet: owner.publicKey, mint: USDC }),
    rp.registerShopIx({ owner: owner.publicKey, payer: relay.publicKey, shopId, mint: USDC, payout }),
  ], relay, [owner]);
  record("register_shop", sig.sig, sig.err);
}
if (!(await conn.getAccountInfo(rp.tillAddress(shop, till.publicKey)))) {
  const sig = await send([rp.addTillIx({ owner: owner.publicKey, payer: relay.publicKey, shop, tillKey: till.publicKey })], relay, [owner]);
  record("add_till", sig.sig, sig.err);
}

// 2. The customer needs devnet USDC.
const custUsdc = rp.associatedTokenAddress(USDC, customer.publicKey);
const bal = await usdcBalance(custUsdc);
const naira = BigInt(Math.round(Number(args.naira ?? 1500) * 100));
const q = await rp.quoteNaira({ connection: mainnet });
const amount = rp.koboToUsdcMicro(naira, q.rateKobo);
console.log(`Rate        1 USDC = N${(Number(q.rateKobo) / 100).toFixed(2)} (${q.source})`);
console.log(`Bill        N${(Number(naira) / 100).toFixed(2)} = ${rp.formatUsdc(amount)} USDC`);
if (bal < amount * 2n) {
  console.error(`\nThe customer has ${rp.formatUsdc(bal)} devnet USDC and needs at least ${rp.formatUsdc(amount * 2n)}.`);
  console.error(`Send devnet USDC to ${customer.publicKey.toBase58()} at https://faucet.circle.com (network: Solana Devnet), then run again.`);
  process.exit(3);
}

// 3. Post a bill from the till, and the customer pays it.
const saleId = ulid();
const post = await send([billIx(saleId, 600)], relay, [till]);
record("post_bill", post.sig, post.err, { sale: rp.bytesToUlid(saleId), naira: Number(naira) / 100, usdc: rp.formatUsdc(amount), rate: Number(q.rateKobo) / 100 });
const pay = await send([payIx(saleId, payout)], relay, [customer]);
record("pay_bill", pay.sig, pay.err);

// 4. The attacks, each sent past simulation so the refusal is on-chain.
const twice = await send([payIx(saleId, payout)], relay, [customer], true);
record("attack: pay the same bill twice", twice.sig, twice.err, { expect: "BillAlreadyPaid" });

const cashier = keyAt(join(root, "keys", "cashier-devnet.json"));
const cashierUsdc = rp.associatedTokenAddress(USDC, cashier.publicKey);
const sale2 = ulid();
const post2 = await send([
  rp.createAssociatedTokenAccountIdempotentIx({ payer: relay.publicKey, wallet: cashier.publicKey, mint: USDC }),
  billIx(sale2, 600),
], relay, [till]);
record("post_bill (for the redirect attempt)", post2.sig, post2.err);
const redirect = await send([payIx(sale2, cashierUsdc)], relay, [customer], true);
record("attack: send the payment to the cashier's own account", redirect.sig, redirect.err, { expect: "WrongPayout" });

const sale3 = ulid();
const post3 = await send([billIx(sale3, 2)], relay, [till]);
record("post_bill (2-second expiry)", post3.sig, post3.err);
await new Promise((r) => setTimeout(r, 15000));
const late = await send([payIx(sale3, payout)], relay, [customer], true);
record("attack: pay after the bill expired", late.sig, late.err, { expect: "BillExpired" });

const stranger = Keypair.generate();
const rogue = await send([rp.postBillIx({ tillKey: stranger.publicKey, payer: relay.publicKey, shop, saleId: ulid(), amount, nairaKobo: naira, rateKobo: q.rateKobo, ttlSecs: 600 })], relay, [stranger], true);
record("attack: post a bill from a till the owner never registered", rogue.sig, rogue.err, { expect: "TillNotRegistered" });

// 5. Re-derive the takings from the chain.
const report = await rp.verifyShop({ connection: conn, shop, delayMs: 250 });
proof.verify = {
  matches: report.matches,
  billsPaid: report.counters.billsPaid.toString(),
  totalUsdc: rp.formatUsdc(report.counters.totalPaidMicro),
  historyBills: report.history.billsPaid,
  historyUsdc: rp.formatUsdc(report.history.totalPaidMicro),
};
console.log(`\nverify: counters ${proof.verify.billsPaid} bills / ${proof.verify.totalUsdc} USDC, history ${proof.verify.historyBills} / ${proof.verify.historyUsdc} -> ${report.matches ? "MATCH" : "MISMATCH"}`);

const out = join(root, "proof", "devnet.json");
mkdirSync(dirname(out), { recursive: true });
const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { runs: [] };
prev.runs.push({ at: new Date().toISOString(), ...proof });
writeFileSync(out, JSON.stringify(prev, null, 2) + "\n");
console.log(`Saved ${out}`);

const failures = proof.steps.filter((s) => (s.expect ? s.error !== s.expect : s.error));
if (failures.length || !report.matches) {
  console.error(`\n${failures.length} step(s) did not behave as expected`);
  process.exitCode = 1;
}

// ---------- helpers ----------

function billIx(saleId, ttlSecs) {
  return rp.postBillIx({ tillKey: till.publicKey, payer: relay.publicKey, shop, saleId, amount, nairaKobo: naira, rateKobo: q.rateKobo, ttlSecs });
}

function payIx(saleId, to) {
  return rp.payBillIx({ customer: customer.publicKey, shop, bill: rp.billAddress(shop, saleId), mint: USDC, payout: to });
}

async function send(ixs, feePayer, signers, skipPreflight = false) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const all = [feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey))];
  tx.sign(...all);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 10 });
  // A failed transaction can make confirmTransaction throw its raw error; the
  // landed transaction below is what we record either way.
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => {});
  const got = await waitTx(sig);
  if (!got) throw new Error(`Transaction ${sig} did not land`);
  const code = got?.meta?.logMessages?.join("\n").match(/Error Code: (\w+)\./)?.[1];
  return { sig, err: got?.meta?.err ? code ?? JSON.stringify(got.meta.err) : null };
}

async function waitTx(sig) {
  for (let i = 0; i < 20; i++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function record(step, sig, error, extra = {}) {
  const ok = extra.expect ? error === extra.expect : !error;
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${error ? ` -> ${error}` : ""}\n     ${ex(sig)}`);
  proof.steps.push({ step, signature: sig, explorer: ex(sig), error, ...extra });
}

async function usdcBalance(acct) {
  const r = await conn.getTokenAccountBalance(acct).catch(() => null);
  return r ? BigInt(r.value.amount) : 0n;
}

function loadKey(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function keyAt(path) {
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return loadKey(path);
}

function ulid() {
  const b = new Uint8Array(16);
  let t = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(randomBytes(10), 6);
  return b;
}
