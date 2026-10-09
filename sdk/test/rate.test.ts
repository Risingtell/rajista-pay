import { describe, expect, it } from "vitest";
import { combine, decodePriceUpdate, koboToUsdcMicro, pythFeedAddress, PYTH_FEED, PYTH_RECEIVER, quoteNaira, RateError } from "../src/rate.js";
import { PublicKey, type Connection } from "@solana/web3.js";

describe("naira rate", () => {
  it("adjusts the USDT price by the USDC/USDT peg", () => {
    const q = combine(1360, 1.0, 0.999, 0);
    expect(q.nairaPerUsdc).toBeCloseTo(1361.3613, 3);
    expect(q.rateKobo).toBe(136136n);
  });

  it("rounds the rate down to the kobo", () => {
    expect(combine(1353.539, 1, 1, 0).rateKobo).toBe(135353n);
  });

  it("refuses zero or negative inputs", () => {
    expect(() => combine(0, 1, 1, 0)).toThrow(RateError);
    expect(() => combine(1360, -1, 1, 0)).toThrow(RateError);
  });
});

describe("naira to USDC", () => {
  it("never lets the shop receive less than the naira price", () => {
    // N10,000 at N1,351.00 per USDC = 7.401924... USDC, so 7.401925 is charged.
    expect(koboToUsdcMicro(1_000_000n, 135100n)).toBe(7_401_925n);
  });

  it("is exact when the division is exact", () => {
    expect(koboToUsdcMicro(135_000n, 135_000n)).toBe(1_000_000n);
  });

  it("refuses a zero amount or rate", () => {
    expect(() => koboToUsdcMicro(0n, 135_000n)).toThrow(RateError);
    expect(() => koboToUsdcMicro(100n, 0n)).toThrow(RateError);
  });
});

describe("Pyth accounts", () => {
  it("derives the same sponsored account addresses that hold the live feeds on mainnet", () => {
    // Checked against mainnet on 2026-10-01: both accounts exist and are
    // owned by the Pyth receiver program.
    expect(pythFeedAddress(PYTH_FEED.USDC_USD).toBase58()).toBe("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");
    expect(pythFeedAddress(PYTH_FEED.USDT_USD).toBase58()).toBe("HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM");
  });

  it("decodes a PriceUpdateV2 account", () => {
    const d = new Uint8Array(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8);
    const v = new DataView(d.buffer);
    let o = 8 + 32;
    d[o] = 1; // Full verification, one byte
    o += 1;
    for (let i = 0; i < 32; i++) d[o + i] = i;
    o += 32;
    v.setBigInt64(o, 99_995_231n, true);
    o += 8;
    v.setBigUint64(o, 12_000n, true);
    o += 8;
    v.setInt32(o, -8, true);
    o += 4;
    v.setBigInt64(o, 1_790_862_145n, true);
    const p = decodePriceUpdate(d);
    expect(p.price).toBeCloseTo(0.99995231, 8);
    expect(p.publishTime).toBe(1_790_862_145);
    expect(p.feedId.slice(0, 6)).toBe("000102");
  });
});

describe("quoteNaira", () => {
  it("combines live-shaped Pyth accounts with the Quidax ticker", async () => {
    const t = Math.floor(Date.now() / 1000);
    const q = await quoteNaira({ connection: fakeConnection(t, 1.0, 0.999), fetch: quidax(t, "1350", "1370") });
    expect(q.usdtNgnMid).toBe(1360);
    expect(q.rateKobo).toBe(136136n);
  });

  it("refuses a stale Pyth price", async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(
      quoteNaira({ connection: fakeConnection(t - 3600, 1, 1), fetch: quidax(t, "1350", "1360") }),
    ).rejects.toThrow(/old/);
  });

  it("refuses a stale Quidax ticker", async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(
      quoteNaira({ connection: fakeConnection(t, 1, 1), fetch: quidax(t - 3600, "1350", "1360") }),
    ).rejects.toThrow(/old/);
  });

  it("refuses a price account that Pyth's receiver does not own", async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(
      quoteNaira({ connection: fakeConnection(t, 1, 1, PublicKey.default), fetch: quidax(t, "1350", "1360") }),
    ).rejects.toThrow(/wrong owner/);
  });
});

function quidax(at: number, buy: string, sell: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: { at, ticker: { buy, sell } } }))) as typeof fetch;
}

function priceAccount(feedHex: string, price: number, publishTime: number): Uint8Array {
  const d = new Uint8Array(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8);
  const v = new DataView(d.buffer);
  let o = 8 + 32;
  d[o] = 1;
  o += 1;
  for (let i = 0; i < 32; i++) d[o + i] = parseInt(feedHex.slice(i * 2, i * 2 + 2), 16);
  o += 32;
  v.setBigInt64(o, BigInt(Math.round(price * 1e8)), true);
  o += 8 + 8;
  v.setInt32(o, -8, true);
  o += 4;
  v.setBigInt64(o, BigInt(publishTime), true);
  return d;
}

function fakeConnection(publishTime: number, usdc: number, usdt: number, owner = PYTH_RECEIVER): Connection {
  const byAddress = new Map([
    [pythFeedAddress(PYTH_FEED.USDC_USD).toBase58(), priceAccount(PYTH_FEED.USDC_USD, usdc, publishTime)],
    [pythFeedAddress(PYTH_FEED.USDT_USD).toBase58(), priceAccount(PYTH_FEED.USDT_USD, usdt, publishTime)],
  ]);
  return {
    async getAccountInfo(key: PublicKey) {
      const data = byAddress.get(key.toBase58());
      return data ? { data: Buffer.from(data), owner, lamports: 1, executable: false } : null;
    },
  } as unknown as Connection;
}
