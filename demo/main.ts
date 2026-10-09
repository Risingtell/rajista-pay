// The judge demo page (docs/index.html). Everything here talks to Solana
// devnet directly from the visitor's browser: no wallet, no server of ours.
//
// "Try to break it" builds each attack as a real transaction and asks devnet
// to simulate it against the deployed program. A simulation runs the actual
// program on the actual accounts and moves nothing, so the refusal you see is
// the program's own answer, not ours. "Rebuild the takings" runs the SDK's
// verifyShop, the same code as `rajista-pay verify`.
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import * as rp from "../sdk/src/index.js";

const RPC = "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const ex = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const exAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

// The devnet demo shop and the accounts its smoke run left on chain.
const SHOP = new PublicKey("A9TEydWP1zqLKEf57rqmrGR4M5HZGa6QL3EEgUWh9k72");
const PAYOUT = new PublicKey("CSKLzSzVr7mRSmJWQwEExzWbAdYnGKeDJK9rwCfosauh");
const TILL = new PublicKey("FWgEypcnoszmVEpqKJp5L8AAyRmANPjVq52RYCsENX2r");
const CUSTOMER = new PublicKey("6pJdJehEL93LvnV4UEEs3cvfiDmJTfsyxQHScZw7EFzW");
const CASHIER_USDC = new PublicKey("CcC5V2yQ92f2xdxhGRuuP4GJUe6LFdwi8SJtYBWj7uRS");
/** Pays the (simulated) network fee. A simulation checks it holds SOL but never charges it. */
const FEE_PAYER = new PublicKey("JdKgpde6UGRU1saiaJyTktdjA4XKTnb3uRGtQu9Siba");
const PAID_BILL = new PublicKey("36vzfikcKJx86RqJZzSXDccWiF33fAZgTjEqPqTsSP5M");
const EXPIRED_BILL = new PublicKey("qDhQ7Niu92WXFiiZjK36kiFdnvaU7Y3rsvSLhDhoVUG");
const MINT = rp.USDC_MINT.devnet;
const RATE = 135_991n; // ₦1,359.91 per USDC, as on the demo bills
const NAIRA = 150_000n; // ₦1,500.00

/** A fresh sale id each click, so the honest bill is always new. */
function saleId(): Uint8Array {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = BigInt(Date.now());
  for (let i = 5; i >= 0; i--, t >>= 8n) b[i] = Number(t & 0xffn);
  return b;
}

const bill = (o: { till?: PublicKey; amount?: bigint; ttl?: number }) =>
  rp.postBillIx({
    tillKey: o.till ?? TILL,
    payer: FEE_PAYER,
    shop: SHOP,
    saleId: saleId(),
    amount: o.amount ?? rp.koboToUsdcMicro(NAIRA, RATE),
    nairaKobo: NAIRA,
    rateKobo: RATE,
    ttlSecs: o.ttl ?? 600,
  });

interface Attack {
  id: string;
  title: string;
  what: string;
  expect: string | null;
  landed?: string;
  ix: () => TransactionInstruction;
}

const ATTACKS: Attack[] = [
  {
    id: "twice",
    title: "Pay the same bill twice",
    what: "The customer's wallet pays a bill that was already paid.",
    expect: "BillAlreadyPaid",
    landed: "5C3MLd5SpSeMwtWkRJnK1FFgE9rGtKLiLZE2zzL81u8w6vrqkACp2htEcjrnD61GkvvUDMzN52qQq8KiqojrMS3T",
    ix: () => rp.payBillIx({ customer: CUSTOMER, shop: SHOP, bill: PAID_BILL, mint: MINT, payout: PAYOUT }),
  },
  {
    id: "redirect",
    title: "Send the money to the cashier",
    what: "The payment names the cashier's own USDC account instead of the owner's.",
    expect: "WrongPayout",
    landed: "2DssHJDBYD5fVUEWSV39AzcLgHsgHfdFyakrQvmcuhcTKw5CdwXyepptHE5L5ky3mzwBFiC98jFRZfCzLqm8xQpb",
    ix: () => rp.payBillIx({ customer: CUSTOMER, shop: SHOP, bill: EXPIRED_BILL, mint: MINT, payout: CASHIER_USDC }),
  },
  {
    id: "late",
    title: "Pay after the bill ran out",
    what: "A bill is good for 10 minutes, because its exchange rate goes stale.",
    expect: "BillExpired",
    landed: "2KA1jL1A41VPcySRXVZc5fFL76zaLk96HZFkQ7KxBri5KeKxnNcTYsW5pHmtUAEHj3zBwP6wvCDk9Ne6ynUFoMEM",
    ix: () => rp.payBillIx({ customer: CUSTOMER, shop: SHOP, bill: EXPIRED_BILL, mint: MINT, payout: PAYOUT }),
  },
  {
    id: "rogue",
    title: "Bill from a till nobody allowed",
    what: "A brand-new key, never registered by the owner, posts a bill for the shop.",
    expect: "TillNotRegistered",
    landed: "3qmvgf2BidzwQCS4D6WW5vtoSr2UET3bwWtxng2brbNvdphSeESxa4VQhETSCLoNbrxVqmRMYgs2TUB5Fh8pvD8j",
    ix: () => bill({ till: Keypair.generate().publicKey }),
  },
  {
    id: "short",
    title: "Charge less than the naira price",
    what: "A real till asks 1.000000 USDC for a ₦1,500 sale, when the rate makes it 1.103015.",
    expect: "AmountMismatch",
    ix: () => bill({ amount: 1_000_000n }),
  },
  {
    id: "stale",
    title: "Keep a bill open for an hour",
    what: "A bill set to stay payable for 60 minutes, past the 15-minute limit.",
    expect: "BadTtl",
    ix: () => bill({ ttl: 3600 }),
  },
  {
    id: "honest",
    title: "An honest bill (should pass)",
    what: "A registered till bills ₦1,500 at the right rate for 10 minutes.",
    expect: null,
    ix: () => bill({}),
  },
];

async function simulate(ix: TransactionInstruction) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: FEE_PAYER, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  const logs = r.value.logs ?? [];
  const code = logs.join("\n").match(/Error Code: (\w+)/)?.[1] ?? null;
  return { ok: r.value.err === null, code, err: r.value.err, logs };
}

// ---------- page wiring ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderAttacks() {
  const list = $("#attacks");
  list.innerHTML = ATTACKS.map(
    (a, i) => `
    <button class="attack" data-id="${a.id}">
      <span class="n">${String(i + 1).padStart(2, "0")}</span>
      <span class="t">${esc(a.title)}</span>
      <span class="w">${esc(a.what)}</span>
    </button>`,
  ).join("");
  list.querySelectorAll<HTMLButtonElement>(".attack").forEach((b) => b.addEventListener("click", () => run(b.dataset.id!)));
}

async function run(id: string) {
  const a = ATTACKS.find((x) => x.id === id)!;
  document.querySelectorAll(".attack").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.id === id));
  const out = $("#verdict");
  out.className = "verdict wait";
  out.innerHTML = `<div class="tag">ASKING DEVNET</div><div class="big">Running "${esc(a.title)}" against the deployed program…</div>`;
  try {
    const r = await simulate(a.ix());
    const refused = !r.ok;
    const asExpected = a.expect ? r.code === a.expect : r.ok;
    const programLines = r.logs.filter((l) => l.includes("4y78XTmZ") || l.includes("Error") || l.includes("Instruction:")).slice(0, 6);
    out.className = `verdict ${refused ? "no" : "yes"}`;
    out.innerHTML = `
      <div class="tag">${refused ? "REFUSED BY THE PROGRAM" : "ACCEPTED BY THE PROGRAM"} · LIVE DEVNET SIMULATION</div>
      <div class="big">${refused ? esc(r.code ?? JSON.stringify(r.err)) : "Bill accepted"}</div>
      <p>${
        refused
          ? asExpected
            ? "This is the program's own error, from the program deployed on devnet, just now."
            : `Expected <code>${esc(a.expect ?? "")}</code>; the program answered differently. Please tell us.`
          : "Simulated only: nothing was posted and nothing was paid. A real bill also needs the till's signature."
      }</p>
      <pre>${programLines.map(esc).join("\n")}</pre>
      ${a.landed ? `<a class="link" href="${ex(a.landed)}" target="_blank" rel="noreferrer">The same attack, sent for real and refused on chain &rarr;</a>` : ""}`;
  } catch (e) {
    out.className = "verdict wait";
    out.innerHTML = `<div class="tag">DEVNET DID NOT ANSWER</div><div class="big">Try again in a few seconds.</div><p>${esc(e instanceof Error ? e.message : String(e))}</p><p>The public devnet RPC limits how often one address may ask.</p>`;
  }
}

async function verify() {
  const btn = $<HTMLButtonElement>("#verify-btn");
  const out = $("#verify-out");
  btn.disabled = true;
  out.innerHTML = `<p class="muted">Reading the shop account and every payment in its history from devnet…</p>`;
  try {
    const r = await rp.verifyShop({ connection: conn, shop: SHOP, delayMs: 400 });
    const rows = r.payments
      .map(
        (p) => `<tr><td>${new Date(p.paidAt * 1000).toISOString().slice(0, 16).replace("T", " ")}</td><td>${rp.formatUsdc(p.usdcMicro)} USDC</td><td>${rp.formatNaira(p.nairaKobo).replace(/^N/, "₦")}</td><td><a href="${ex(p.signature)}" target="_blank" rel="noreferrer">${p.signature.slice(0, 8)}…</a></td></tr>`,
      )
      .join("");
    out.innerHTML = `
      <div class="tablewrap"><table><thead><tr><th>Paid (UTC)</th><th>USDC</th><th>Naira</th><th>Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="sums">
        <div><span class="muted">Shop account counters</span><b>${r.counters.billsPaid} bills · ${rp.formatUsdc(r.counters.totalPaidMicro)} USDC</b></div>
        <div><span class="muted">Rebuilt from history</span><b>${r.history.billsPaid} bills · ${rp.formatUsdc(r.history.totalPaidMicro)} USDC</b></div>
      </div>
      <div class="verdict ${r.matches ? "yes" : "no"}" style="margin-top:16px"><div class="big">${r.matches ? "MATCH" : "MISMATCH"}</div><p>${r.matches ? "The program's running totals and its payment history agree." : "They disagree. Please tell us."}</p></div>`;
  } catch (e) {
    out.innerHTML = `<p>Devnet did not answer (${esc(e instanceof Error ? e.message : String(e))}). Try again in a few seconds.</p>`;
  } finally {
    btn.disabled = false;
  }
}

renderAttacks();
$("#verify-btn").addEventListener("click", () => void verify());
$("#program-link").setAttribute("href", exAddr(rp.TILL_PROGRAM_ID.toBase58()));
$("#shop-link").setAttribute("href", exAddr(SHOP.toBase58()));
