// Re-derive a shop's USDC takings straight from the chain.
//
// Two independent records have to agree: the shop account's running totals
// (bills_paid, total_paid), which the program updates on every payment, and
// the BillPaid events in the transaction history. Nothing here reads Rajista's
// own database, so a match is evidence the books were not typed in by hand.
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { billPaidEventsFromLogs, bytesToUlid, decodeShop, TILL_PROGRAM_ID, type BillPaidEvent } from "./program.js";

export interface VerifiedPayment {
  signature: string;
  sale: string; // Rajista sale id (ULID)
  bill: string;
  usdcMicro: bigint;
  nairaKobo: bigint;
  rateKobo: bigint;
  payer: string;
  payout: string;
  paidAt: number;
}

export interface VerifyReport {
  shop: string;
  owner: string;
  payout: string;
  counters: { billsPaid: bigint; totalPaidMicro: bigint };
  history: { billsPaid: number; totalPaidMicro: bigint; totalNairaKobo: bigint };
  payments: VerifiedPayment[];
  matches: boolean;
  /** True when history paging stopped at the cap, so the history may be partial. */
  truncated: boolean;
}

export interface VerifyOptions {
  connection: Connection;
  shop: PublicKey;
  programId?: PublicKey;
  /** Pages of 1,000 signatures to read at most. Default 20. */
  maxPages?: number;
  /** Pause between transaction reads, to stay under public RPC limits. Default 120 ms. */
  delayMs?: number;
}

export async function verifyShop(o: VerifyOptions): Promise<VerifyReport> {
  const programId = o.programId ?? TILL_PROGRAM_ID;
  const info = await o.connection.getAccountInfo(o.shop, "confirmed");
  if (!info) throw new Error(`No shop account at ${o.shop.toBase58()}`);
  if (!info.owner.equals(programId)) throw new Error("That account is not a Rajista Pay shop");
  const shop = decodeShop(info.data);

  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  let truncated = false;
  const maxPages = o.maxPages ?? 20;
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await o.connection.getSignaturesForAddress(o.shop, { before, limit: 1000 }, "confirmed");
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }

  const payments: VerifiedPayment[] = [];
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await o.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (o.delayMs !== 0) await sleep(o.delayMs ?? 120);
    if (!tx?.meta || tx.meta.err) continue;
    for (const ev of billPaidEventsFromLogs(tx.meta.logMessages ?? [])) {
      if (!ev.shop.equals(o.shop)) continue;
      const key = `${s.signature}:${ev.bill.toBase58()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      payments.push(toPayment(s.signature, ev));
    }
  }
  payments.sort((a, b) => a.paidAt - b.paidAt);

  const totalPaidMicro = payments.reduce((t, p) => t + p.usdcMicro, 0n);
  const totalNairaKobo = payments.reduce((t, p) => t + p.nairaKobo, 0n);
  return {
    shop: o.shop.toBase58(),
    owner: shop.owner.toBase58(),
    payout: shop.payout.toBase58(),
    counters: { billsPaid: shop.billsPaid, totalPaidMicro: shop.totalPaid },
    history: { billsPaid: payments.length, totalPaidMicro, totalNairaKobo },
    payments,
    matches: !truncated && BigInt(payments.length) === shop.billsPaid && totalPaidMicro === shop.totalPaid,
    truncated,
  };
}

function toPayment(signature: string, ev: BillPaidEvent): VerifiedPayment {
  return {
    signature,
    sale: bytesToUlid(ev.saleId),
    bill: ev.bill.toBase58(),
    usdcMicro: ev.amount,
    nairaKobo: ev.nairaKobo,
    rateKobo: ev.rateKobo,
    payer: ev.payer.toBase58(),
    payout: ev.payout.toBase58(),
    paidAt: ev.paidAt,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export function formatNaira(kobo: bigint): string {
  const whole = (kobo / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `N${whole}.${(kobo % 100n).toString().padStart(2, "0")}`;
}
