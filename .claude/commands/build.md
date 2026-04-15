---
description: "Build production bundle"
allowed-tools: Bash(*)
---

# Build Command

Build realvirtual WEB for production deployment.

## Task

1. Run type-check:
```bash
npx tsc --noEmit
```

If errors: fix them before proceeding.

2. Run tests:
```bash
npm test
```

If failures: fix them before proceeding.

3. Build production bundle:
```bash
npm run build
```

4. Report: output directory (`dist/`), bundle size, any warnings.
