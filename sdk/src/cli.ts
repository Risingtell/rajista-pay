#!/usr/bin/env node
// rajista-pay verify <shop>   re-derive a shop's USDC takings from the chain
// rajista-pay quote           today's naira price of one USDC, with its sources
import { Connection, PublicKey } from "@solana/web3.js";
import { quoteNaira } from "./rate.js";
import { formatNaira, formatUsdc, verifyShop } from "./verify.js";

const RPC: Record<string, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

const USAGE = `Usage:
  rajista-pay verify <shop-address> [--cluster mainnet|devnet] [--rpc <url>] [--json]
  rajista-pay quote [--rpc <url>] [--json]

verify  Reads the shop's on-chain totals and every BillPaid event in its history,
        and checks that they agree. Exit code 0 = they match, 1 = they do not.
quote   Naira per USDC: Quidax USDT/NGN mid, adjusted by Pyth USDC/USD and USDT/USD
        read from Solana mainnet. Always uses mainnet prices.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  if (cmd === "quote") {
    const connection = new Connection(flags.rpc ?? RPC.mainnet, "confirmed");
    const q = await quoteNaira({ connection });
    if (flags.json) {
      console.log(JSON.stringify({ ...q, rateKobo: q.rateKobo.toString() }, null, 2));
    } else {
      console.log(`1 USDC = ${formatNaira(q.rateKobo)}`);
      console.log(`  Quidax USDT/NGN mid  ${q.usdtNgnMid.toFixed(2)}`);
      console.log(`  Pyth USDC/USD        ${q.usdcUsd.toFixed(6)}`);
      console.log(`  Pyth USDT/USD        ${q.usdtUsd.toFixed(6)}`);
      console.log(`  as of                ${new Date(q.asOf).toISOString()}`);
    }
    return 0;
  }

  if (cmd === "verify") {
    const shopArg = flags._[0];
    if (!shopArg) {
      console.error(USAGE);
      return 2;
    }
    let shop: PublicKey;
    try {
      shop = new PublicKey(shopArg);
    } catch {
      console.error(`Not a Solana address: ${shopArg}`);
      return 2;
    }
    const cluster = flags.cluster ?? "mainnet";
    const url = flags.rpc ?? RPC[cluster];
    if (!url) {
      console.error(`Unknown cluster ${cluster}; use mainnet, devnet or --rpc`);
      return 2;
    }
    const r = await verifyShop({ connection: new Connection(url, "confirmed"), shop });
    if (flags.json) {
      console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return r.matches ? 0 : 1;
    }
    const ex = cluster === "mainnet" ? "" : `?cluster=${cluster}`;
    console.log(`Shop     ${r.shop}`);
    console.log(`Payout   ${r.payout}`);
    console.log("");
    for (const p of r.payments) {
      console.log(
        `${new Date(p.paidAt * 1000).toISOString().slice(0, 16).replace("T", " ")}  ${formatUsdc(p.usdcMicro).padStart(12)} USDC  ${formatNaira(p.nairaKobo).padStart(14)}  sale ${p.sale}`,
      );
      console.log(`    https://explorer.solana.com/tx/${p.signature}${ex}`);
    }
    console.log("");
    console.log(`On-chain counters   ${r.counters.billsPaid} bills   ${formatUsdc(r.counters.totalPaidMicro)} USDC`);
    console.log(`From history        ${r.history.billsPaid} bills   ${formatUsdc(r.history.totalPaidMicro)} USDC   ${formatNaira(r.history.totalNairaKobo)}`);
    if (r.truncated) console.log("History is longer than the page cap; totals above are partial.");
    console.log(r.matches ? "MATCH: the counters and the payment history agree." : "MISMATCH: the counters and the payment history disagree.");
    return r.matches ? 0 : 1;
  }

  console.error(`Unknown command ${cmd}\n\n${USAGE}`);
  return 2;
}

function parseFlags(args: string[]) {
  const out: { _: string[]; cluster?: string; rpc?: string; json?: boolean } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--cluster") out.cluster = args[++i];
    else if (a === "--rpc") out.rpc = args[++i];
    else out._.push(a);
  }
  return out;
}

// Set the exit code and let Node wind down on its own. Calling process.exit()
// while a fetch socket is still closing aborts Node 24 on Windows with a libuv
// assertion and exit code 127, which would read as a failure. The unref'd
// timer only ends a process that something else is keeping alive.
const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
};
main(process.argv.slice(2)).then(finish, (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  finish(1);
});
