---
description: "Check and add AGPL license headers to source files"
allowed-tools: Bash(*)
---

# License Check Command

Verify all source files have AGPL-3.0 license headers.

## Task

1. Run the license header script in dry mode first:
```bash
node scripts/add-license-headers.mjs --dry
```

2. If files are missing headers, run it for real:
```bash
node scripts/add-license-headers.mjs
```

3. Report: how many files were updated, how many already had headers, how many skipped.
