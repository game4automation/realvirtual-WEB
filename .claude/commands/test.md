---
description: "Run type-check and all tests"
allowed-tools: Bash(*)
---

# Test Command

Run TypeScript type-check and all Vitest browser tests.

## Task

1. Run type-check:
```bash
npx tsc --noEmit
```

If errors: show them and stop.

2. Run all tests:
```bash
npm test
```

If failures: show them and stop.

3. Report summary: number of test files, total tests passed, any warnings.
