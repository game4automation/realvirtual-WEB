---
description: "Start the realvirtual WEB dev server"
allowed-tools: Bash(*)
---

# Dev Server

Start the Vite dev server with HMR.

## Task

1. Kill any leftover Node.js processes to free ports:

```bash
taskkill //F //IM node.exe 2>/dev/null || true
```

2. Start the dev server in the background:

```bash
npm run dev
```

Run step 2 in the background. The server runs on `localhost:5173` and opens the browser automatically.
