# Rajista Pay

[![ci](https://github.com/Risingtell/rajista-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/Risingtell/rajista-pay/actions/workflows/ci.yml)

**[Try to break it in your browser](https://risingtell.github.io/rajista-pay/)**: attack the deployed program and watch it refuse. No wallet needed.

**Take USDC at a shop till, on Solana.** A cashier rings up a sale in naira; the customer scans a QR and pays the exact amount in USDC from their own wallet. An on-chain program makes sure the money can only go to the shop owner's wallet, only once, and only for the agreed price.

Rajista Pay is the open-source payment layer of [Rajista](https://rajista-www.rajista.workers.dev), a point-of-sale app for small Nigerian shops. This repo is the Solana program, a TypeScript SDK, and a `verify` command that rebuilds any shop's takings from the chain.

> **Status: DEVNET.** The program runs on Solana devnet with test USDC. Mainnet is the next step. Every link below is a real devnet transaction you can open.

| | |
|---|---|
| Program (devnet) | [`4y78XTmZk9GERsxhP4ezpnfuqX2iZh3Dq3aKZYk3XtQq`](https://explorer.solana.com/address/4y78XTmZk9GERsxhP4ezpnfuqX2iZh3Dq3aKZYk3XtQq?cluster=devnet) |
| Deployed bytes | identical to `cargo build-sbf` of this source (237,072 bytes) |
| Program tests | 19, run in LiteSVM, one per rule ([tests/till.test.ts](tests/till.test.ts)) |
| SDK tests | 12 ([sdk/test](sdk/test)) |
| Attacks refused on chain | 4 of 4, each with an explorer link ([below](#the-rule-the-program-enforces)) |
| In a real app | Live inside Rajista's till, behind a switch each shop turns on |

## Why

The naira has lost about two thirds of its value against the dollar since early 2023, and more customers keep their money in dollars on their phones. Without a proper tool, taking that money at a counter means a staff member's personal wallet address, a rate worked out by hand, and nothing in the books. Rajista Pay replaces that with a bill the chain enforces and a record the shop can check.

## How a sale works

1. **The cashier rings up the sale in naira** and taps USDC in Rajista.
2. **The rate.** The relay quotes naira per USDC from the Quidax USDT/NGN market, corrected by the Pyth USDC/USD and USDT/USD prices read from Solana, so a stablecoin drifting off its peg does not move the price.
3. **The bill.** The till signs a bill with its own key: sale id, naira amount, rate, USDC amount, a 10-minute expiry. The program checks the USDC amount really is the naira price at that rate, and that this till is one the owner registered.
4. **The customer pays.** The till shows a [Solana Pay](https://docs.solanapay.com/spec#specification-transaction-request) transaction-request QR. The customer's wallet (Phantom or any Solana wallet) gets the payment from the relay, which pays the network fee, so the customer needs USDC only, no SOL.
5. **The program moves exactly the bill's USDC into the owner's payout account** and marks the bill paid.
6. **The till reads the bill back from Solana**, and only then records the sale, with the transaction as its proof. The receipt shows the USDC, the rate and the transaction; the reports show USDC beside its naira value.

The owner sets the shop up once by scanning a QR with their own wallet. That fixes where every payment goes. Rajista never holds the money and cannot change where it goes.

## The rule the program enforces

A bill can be paid **once**, for **exactly** its amount, in **USDC only**, **only** into the payout account the owner set, and **only** before it expires. Only a till the owner registered can post a bill, and only the owner can change the payout.

Each refusal below was sent to devnet on purpose, past simulation, so it is recorded on chain:

| Someone tries to | The program answers | On devnet | Test |
|---|---|---|---|
| pay the same bill twice | `BillAlreadyPaid` | [5C3MLd5S...](https://explorer.solana.com/tx/5C3MLd5SpSeMwtWkRJnK1FFgE9rGtKLiLZE2zzL81u8w6vrqkACp2htEcjrnD61GkvvUDMzN52qQq8KiqojrMS3T?cluster=devnet) | `rejects_second_payment` |
| send the payment to the cashier's own account | `WrongPayout` | [2DssHJDB...](https://explorer.solana.com/tx/2DssHJDBYD5fVUEWSV39AzcLgHsgHfdFyakrQvmcuhcTKw5CdwXyepptHE5L5ky3mzwBFiC98jFRZfCzLqm8xQpb?cluster=devnet) | `rejects_redirected_payout` |
| pay after the bill ran out | `BillExpired` | [2KA1jL1A...](https://explorer.solana.com/tx/2KA1jL1A41VPcySRXVZc5fFL76zaLk96HZFkQ7KxBri5KeKxnNcTYsW5pHmtUAEHj3zBwP6wvCDk9Ne6ynUFoMEM?cluster=devnet) | `rejects_expired_bill` |
| post a bill from a till the owner never registered | `TillNotRegistered` | [3qmvgf2B...](https://explorer.solana.com/tx/3qmvgf2BidzwQCS4D6WW5vtoSr2UET3bwWtxng2brbNvdphSeESxa4VQhETSCLoNbrxVqmRMYgs2TUB5Fh8pvD8j?cluster=devnet) | `rejects_unregistered_till` |

And the payment that should succeed: [bill posted](https://explorer.solana.com/tx/2D24X1JaQPF4xyTjm4RuKaQx5L9P3eZ2iGfetcuYRihBkLPko2oyutEmmoFpkoBvvC1MhHRKFXWFtxd1hudF5WXc?cluster=devnet), then [paid: ₦1,500 as 1.102958 USDC](https://explorer.solana.com/tx/2fFmDHAPqbhaN1VA5gDyfCN2v25JuwWVwtjN3JzoGeQ9NZAf3ga85r726YgXvnb3GLjhyZvkwW37ZrvaZeLHYyUK?cluster=devnet).

The tests also cover a non-USDC mint, another token from the customer, a removed till, a USDC amount that does not match the naira price, a bill open longer than 15 minutes, the same sale billed twice, a payout change by someone other than the owner, closing an open bill, and rent sent to anyone but its payer.

## Check it yourself

You need Node 20 or newer. Nothing else: no wallet, no key, no sign-up.

```bash
git clone https://github.com/Risingtell/rajista-pay.git
cd rajista-pay/sdk
npm ci
npm run build

# Rebuild the devnet demo shop's takings from the chain, and check them
# against the program's own counters. Exit code 0 means they agree.
node dist/cli.js verify A9TEydWP1zqLKEf57rqmrGR4M5HZGa6QL3EEgUWh9k72 --cluster devnet

# Today's naira price of one USDC, with its sources.
node dist/cli.js quote
```

`verify` reads every `BillPaid` event in the shop's history and compares the total with the shop account's running counters. It does not use Rajista's database or our server. [JUDGE-QUICKSTART.md](JUDGE-QUICKSTART.md) has the five-minute version with expected output.

## Use the SDK

```ts
import { Connection } from "@solana/web3.js";
import * as rp from "rajista-pay";

// The naira price of one USDC right now, and the USDC for a ₦1,500 sale.
const quote = await rp.quoteNaira({ connection: new Connection("https://api.mainnet-beta.solana.com") });
const usdc = rp.koboToUsdcMicro(150_000n, quote.rateKobo); // rounded up, never short

// The instructions a till and a wallet sign.
const post = rp.postBillIx({ tillKey, payer, shop, saleId, amount: usdc, nairaKobo: 150_000n, rateKobo: quote.rateKobo, ttlSecs: 600 });
const pay = rp.payBillIx({ customer, shop, bill: rp.billAddress(shop, saleId), mint: rp.USDC_MINT.devnet, payout });

// Everything a shop was paid, re-derived from the chain.
const report = await rp.verifyShop({ connection, shop });
```

The client is written by hand, without the Anchor TypeScript client, so a till running in a phone browser loads as little code as possible.

## Repository

| Path | What it is |
|---|---|
| [`programs/till`](programs/till/src/lib.rs) | The Anchor program: shops, tills, bills, payment, closing |
| [`tests`](tests/till.test.ts) | 19 program tests in LiteSVM, named after the rule each one defends |
| [`sdk`](sdk) | TypeScript SDK and the `rajista-pay` CLI (`verify`, `quote`) |
| [`sdk/scripts/devnet-smoke.mjs`](sdk/scripts/devnet-smoke.mjs) | The full flow plus the four attacks, against devnet; writes [`proof/devnet.json`](proof/devnet.json) |
| [`demo`](demo/main.ts), [`docs`](docs/index.html) | The "try to break it" page: each attack is simulated against devnet from the visitor's browser. Rebuild with `NODE_PATH=sdk/node_modules npx esbuild demo/main.ts --bundle --minify --format=esm --platform=browser --outfile=docs/app.js` |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Builds the program and runs both test suites on every push |

## Run the tests

SDK, on any OS:

```bash
cd sdk && npm ci && npm test
```

Program, on Linux, macOS or WSL (LiteSVM has no Windows build). Needs Rust and the Solana CLI for `cargo build-sbf`:

```bash
cargo build-sbf --manifest-path programs/till/Cargo.toml
(cd sdk && npm ci) && cd tests && npm ci && npm test
```

## Limits, plainly

- **Devnet only.** The program is not on mainnet yet. Moving it is a deploy plus a funded fee payer; the code does not change.
- **The relay builds the bill a till signs.** A compromised relay could ask a till to sign a wrong bill, so the till reads the bill back from Solana and refuses to record a sale whose amount or sale id does not match. The relay can never move money: only the customer's wallet can pay, and only into the owner's payout.
- **One exchange sets the naira rate.** Quidax's USDT/NGN market, adjusted by Pyth. The rate a bill was paid at is stored on chain with it, so any later dispute is checkable.
- **Refunds are not on chain.** A USDC sale returned to the shop is refunded in cash or by transfer in Rajista, as any other sale.
- **Rajista itself is private.** The till app and relay that use this SDK are in a private repository; this repo is everything that touches the chain.

## License

[MIT](LICENSE)
