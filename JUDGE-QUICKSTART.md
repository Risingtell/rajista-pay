# Judge quickstart: five minutes, no wallet

Everything here runs against Solana devnet and needs only Node 20 or newer. No key, no sign-up, no wallet.

## 1. Rebuild a shop's takings from the chain (2 minutes)

```bash
git clone https://github.com/Risingtell/rajista-pay.git
cd rajista-pay/sdk
npm ci
npm run build
node dist/cli.js verify A9TEydWP1zqLKEf57rqmrGR4M5HZGa6QL3EEgUWh9k72 --cluster devnet
echo "exit code: $?"
```

Expected (the devnet demo shop):

```
Shop     A9TEydWP1zqLKEf57rqmrGR4M5HZGa6QL3EEgUWh9k72
Payout   CSKLzSzVr7mRSmJWQwEExzWbAdYnGKeDJK9rwCfosauh

2026-10-04 15:40      1.103023 USDC       N1,500.00  sale 01M43S5KVF2QMS1XQPXC7B0SXB
    https://explorer.solana.com/tx/3SpDDBy3...?cluster=devnet
2026-10-04 15:41      1.102958 USDC       N1,500.00  sale 01M43S6ZRNZDRF1N2S39V69FJS
    https://explorer.solana.com/tx/2fFmDHAP...?cluster=devnet

On-chain counters   2 bills   2.205981 USDC
From history        2 bills   2.205981 USDC   N3,000.00
MATCH: the counters and the payment history agree.
exit code: 0
```

What it proves: the program keeps a running total on the shop's account, and every payment also emits a `BillPaid` event. `verify` reads both straight from Solana and checks they agree. It never touches Rajista's database or our server. Add `--json` for machine-readable output. Point it at any address that is not a shop and it says so and exits 1.

## 2. See the program refuse (1 minute)

Open these devnet transactions. Each was sent on purpose, past simulation, so the refusal is on chain. Scroll to **Program Logs** and look for `Error Code:`.

| Attempt | Expected error | Transaction |
|---|---|---|
| Pay the same bill twice | `BillAlreadyPaid` | [open](https://explorer.solana.com/tx/5C3MLd5SpSeMwtWkRJnK1FFgE9rGtKLiLZE2zzL81u8w6vrqkACp2htEcjrnD61GkvvUDMzN52qQq8KiqojrMS3T?cluster=devnet) |
| Send the payment to the cashier's own account | `WrongPayout` | [open](https://explorer.solana.com/tx/2DssHJDBYD5fVUEWSV39AzcLgHsgHfdFyakrQvmcuhcTKw5CdwXyepptHE5L5ky3mzwBFiC98jFRZfCzLqm8xQpb?cluster=devnet) |
| Pay after the bill ran out | `BillExpired` | [open](https://explorer.solana.com/tx/2KA1jL1A41VPcySRXVZc5fFL76zaLk96HZFkQ7KxBri5KeKxnNcTYsW5pHmtUAEHj3zBwP6wvCDk9Ne6ynUFoMEM?cluster=devnet) |
| Post a bill from an unregistered till | `TillNotRegistered` | [open](https://explorer.solana.com/tx/3qmvgf2BidzwQCS4D6WW5vtoSr2UET3bwWtxng2brbNvdphSeESxa4VQhETSCLoNbrxVqmRMYgs2TUB5Fh8pvD8j?cluster=devnet) |

The rules themselves are in [`programs/till/src/lib.rs`](programs/till/src/lib.rs), `pay_bill` and `post_bill`.

## 3. Today's rate (30 seconds)

```bash
node dist/cli.js quote
```

Prints naira per USDC and its three inputs: the Quidax USDT/NGN mid price, and the Pyth USDC/USD and USDT/USD prices read from Solana mainnet. Rajista's till uses this same code to price every bill.

## 4. The tests (optional)

SDK tests, any OS:

```bash
npm test          # in sdk/: 12 tests
```

The 19 program tests run the compiled program in LiteSVM, one test per rule (`rejects_second_payment`, `rejects_redirected_payout`, `rejects_expired_bill`, `rejects_unregistered_till`, and so on). They need Linux, macOS or WSL, Rust and the Solana CLI; the commands are in the [README](README.md#run-the-tests). CI runs them on every push: see the **Actions** tab.

## 5. Run the whole flow yourself (optional, needs devnet SOL and USDC)

`sdk/scripts/devnet-smoke.mjs` registers a shop, posts and pays a bill, sends the four attacks and runs `verify`, all on devnet:

```bash
node scripts/devnet-smoke.mjs --owner <your devnet keypair.json>
```

The owner keypair needs about 0.05 devnet SOL (`solana airdrop 1`); the script makes a customer key under `keys/` and tells you its address to fund with devnet USDC from [faucet.circle.com](https://faucet.circle.com).
