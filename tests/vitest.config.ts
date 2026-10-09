import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // One copy of each Solana library, so instructions built by the SDK and
    // transactions built here are the same classes.
    dedupe: ["@solana/web3.js", "@solana/spl-token", "@noble/hashes", "buffer"],
  },
  test: {
    testTimeout: 30_000,
  },
});
