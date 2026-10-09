// The naira price of one USDC, from public sources only.
//
// No exchange quotes USDC against naira in a public API we could find, and
// Pyth has no NGN feed. Quidax does publish USDT/NGN. So the rate is built
// from three numbers, each one a source anyone can check:
//
//   naira per USDC = Quidax USDT/NGN mid x (Pyth USDC/USD / Pyth USDT/USD)
//
// The Pyth prices are read straight from Pyth's sponsored price accounts on
// Solana mainnet, not from Hermes, which needs an API key. Reading them with
// a plain RPC call keeps the till free of any key on the critical path.
import { Connection, PublicKey } from "@solana/web3.js";

/** Pyth's push-oracle program that owns the sponsored price accounts. */
export const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
/** The Pyth Solana Receiver, which writes every PriceUpdateV2 account. */
export const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

export const PYTH_FEED = {
  USDC_USD: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT_USD: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
} as const;

export const QUIDAX_TICKER = "https://app.quidax.io/api/v1/markets/tickers/usdtngn";

export interface PythPrice {
  feedId: string;
  price: number;
  conf: number;
  publishTime: number; // unix seconds
}

export interface NairaQuote {
  /** Naira per 1 USDC, rounded down to the kobo. This is what the bill records. */
  rateKobo: bigint;
  nairaPerUsdc: number;
  usdtNgnMid: number;
  usdcUsd: number;
  usdtUsd: number;
  /** Unix ms of the oldest input, so a reader can see how fresh the rate is. */
  asOf: number;
  source: string;
}

/** Address of Pyth's sponsored price account for a feed (shard 0). */
export function pythFeedAddress(feedIdHex: string, shard = 0): PublicKey {
  const s = new Uint8Array(2);
  new DataView(s.buffer).setUint16(0, shard, true);
  return PublicKey.findProgramAddressSync([s, hexToBytes(feedIdHex)], PYTH_PUSH_ORACLE)[0];
}

/**
 * Decode a PriceUpdateV2 account. Layout: 8 discriminator, 32 write authority,
 * verification level (1 byte for Full, 2 for Partial), 32 feed id, i64 price,
 * u64 conf, i32 exponent, i64 publish time.
 */
export function decodePriceUpdate(data: Uint8Array): PythPrice {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  o += data[o] === 0 ? 2 : 1;
  const feedId = bytesToHex(data.subarray(o, o + 32));
  o += 32;
  const price = v.getBigInt64(o, true);
  o += 8;
  const conf = v.getBigUint64(o, true);
  o += 8;
  const expo = v.getInt32(o, true);
  o += 4;
  const publishTime = Number(v.getBigInt64(o, true));
  const scale = 10 ** expo;
  return { feedId, price: Number(price) * scale, conf: Number(conf) * scale, publishTime };
}

export async function readPythPrice(connection: Connection, feedIdHex: string): Promise<PythPrice> {
  const info = await connection.getAccountInfo(pythFeedAddress(feedIdHex));
  if (!info) throw new RateError(`Pyth price account for ${feedIdHex} not found`);
  if (!info.owner.equals(PYTH_RECEIVER)) throw new RateError("Pyth price account has the wrong owner");
  const p = decodePriceUpdate(info.data);
  if (p.feedId !== feedIdHex) throw new RateError("Pyth price account holds a different feed");
  return p;
}

export async function readQuidaxMid(fetcher: typeof fetch = fetch): Promise<{ mid: number; at: number }> {
  const res = await fetcher(QUIDAX_TICKER);
  if (!res.ok) throw new RateError(`Quidax answered ${res.status}`);
  const body = (await res.json()) as { data?: { at?: number; ticker?: { buy?: string; sell?: string } } };
  const buy = Number(body.data?.ticker?.buy);
  const sell = Number(body.data?.ticker?.sell);
  const at = Number(body.data?.at);
  if (!(buy > 0) || !(sell > 0) || !(at > 0)) throw new RateError("Quidax ticker is missing buy, sell or time");
  return { mid: (buy + sell) / 2, at: at * 1000 };
}

export interface QuoteOptions {
  connection: Connection;
  fetch?: typeof fetch;
  /** Reject any input older than this. Default 300 seconds. */
  maxAgeSec?: number;
  now?: () => number;
}

export async function quoteNaira(opts: QuoteOptions): Promise<NairaQuote> {
  const now = (opts.now ?? Date.now)();
  const maxAge = (opts.maxAgeSec ?? 300) * 1000;
  const [usdc, usdt, quidax] = await Promise.all([
    readPythPrice(opts.connection, PYTH_FEED.USDC_USD),
    readPythPrice(opts.connection, PYTH_FEED.USDT_USD),
    readQuidaxMid(opts.fetch),
  ]);
  const asOf = Math.min(usdc.publishTime * 1000, usdt.publishTime * 1000, quidax.at);
  if (now - asOf > maxAge) throw new RateError(`Rate inputs are ${Math.round((now - asOf) / 1000)}s old`);
  return combine(quidax.mid, usdc.price, usdt.price, asOf);
}

/** The arithmetic on its own, so it can be tested without the network. */
export function combine(usdtNgnMid: number, usdcUsd: number, usdtUsd: number, asOf: number): NairaQuote {
  if (!(usdtNgnMid > 0 && usdcUsd > 0 && usdtUsd > 0)) throw new RateError("Rate inputs must be positive");
  const nairaPerUsdc = usdtNgnMid * (usdcUsd / usdtUsd);
  return {
    rateKobo: BigInt(Math.floor(nairaPerUsdc * 100)),
    nairaPerUsdc,
    usdtNgnMid,
    usdcUsd,
    usdtUsd,
    asOf,
    source: "quidax:usdtngn+pyth:usdc/usd,usdt/usd",
  };
}

/**
 * How many micro-USDC a naira total costs at a rate. Rounded UP to the next
 * micro-USDC so the shop never receives less than the naira price.
 */
export function koboToUsdcMicro(kobo: bigint, rateKobo: bigint): bigint {
  if (kobo <= 0n) throw new RateError("Amount must be above zero");
  if (rateKobo <= 0n) throw new RateError("Rate must be above zero");
  const n = kobo * 1_000_000n;
  return (n + rateKobo - 1n) / rateKobo;
}

export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new RateError("Feed id must be 32 bytes of hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
