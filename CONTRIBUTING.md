# Contributing

Thank you for looking.

1. Open an issue first for anything bigger than a typo, so we agree on the approach.
2. Every change to the program needs a test in `tests/till.test.ts`, named after the rule it defends (`rejects_...` for a refusal).
3. Run both suites before opening a pull request:
   ```bash
   (cd sdk && npm test)
   cargo build-sbf --manifest-path programs/till/Cargo.toml && (cd tests && npm test)
   ```
4. Keep the SDK free of the Anchor TypeScript client: it runs in phone browsers, so every kilobyte counts.

By contributing you agree your work is released under the MIT license.
