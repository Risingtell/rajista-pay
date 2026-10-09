# rajista-pay

Take USDC at a shop till, on Solana. Client and CLI for the [Rajista Pay program](https://github.com/Risingtell/rajista-pay): on-chain bills that can only be paid once, for the agreed naira price, into the shop owner's wallet.

> The program is on **Solana devnet** (`4y78XTmZk9GERsxhP4ezpnfuqX2iZh3Dq3aKZYk3XtQq`). Mainnet is next.

## CLI

```bash
# Re-derive a shop's USDC takings from the chain and check them against its counters.
npx rajista-pay verify A9TEydWP1zqLKEf57rqmrGR4M5HZGa6QL3EEgUWh9k72 --cluster devnet

# Today's naira price of one USDC: Quidax USDT/NGN, corrected by Pyth USDC/USD and USDT/USD.
npx rajista-pay quote
```

`verify` exits 0 when the shop's on-chain counters and its `BillPaid` history agree, 1 when they do not. Add `--json` for machine-readable output, `--rpc <url>` for your own RPC.

## Library

```ts
import { Connection } from "@solana/web3.js";
import * as rp from "rajista-pay";

const mainnet = new Connection("https://api.mainnet-beta.solana.com");
const quote = await rp.quoteNaira({ connection: mainnet });          // { rateKobo, source, asOf, ... }
const usdc = rp.koboToUsdcMicro(150_000n, quote.rateKobo);          // ₦1,500 in micro-USDC, rounded up

// Addresses
rp.shopAddress(owner, shopId);         // one shop per owner and 16-byte id
rp.tillAddress(shop, tillKey);         // a till the owner registered
rp.billAddress(shop, saleId);          // one bill per sale

// Instructions
rp.registerShopIx({ owner, payer, shopId, mint: rp.USDC_MINT.devnet, payout });
rp.addTillIx({ owner, payer, shop, tillKey });
rp.postBillIx({ tillKey, payer, shop, saleId, amount: usdc, nairaKobo: 150_000n, rateKobo: quote.rateKobo, ttlSecs: 600 });
rp.payBillIx({ customer, shop, bill, mint: rp.USDC_MINT.devnet, payout });
rp.closeBillIx({ closer, bill, rentPayer });

// Reading
rp.decodeShop(data); rp.decodeBill(data); rp.billPaidEventsFromLogs(logs);
await rp.verifyShop({ connection, shop });
```

Written by hand without the Anchor TypeScript client, so a till in a phone browser loads as little as possible. Sale ids are 16 bytes; `ulidToBytes` and `bytesToUlid` convert Rajista's ULIDs.

## License

MIT
