---
description: "Visually inspect the running realvirtual WEB via Playwright"
allowed-tools: Bash(*), WebFetch, Read, mcp__playwright__*
---

# Inspect Command

Uses Playwright MCP to visually inspect and interact with the running realvirtual WEB instance.

## Usage

```
/inspect                     # Open realvirtual WEB, report page structure
/inspect screenshot          # Capture a screenshot
/inspect click <element>     # Click a UI element by accessible name
/inspect check               # Health check: model loaded, no errors, FPS ok
```

## Prerequisites

- Dev server must be running (`/dev` or `npm run dev`)
- Playwright MCP must be available

## Workflow

### `/inspect` (default)

1. Navigate to `http://localhost:5173` using `browser_navigate`
2. Wait for page load
3. Use `browser_snapshot` to get the accessibility tree
4. Report: page title, visible UI elements, any error indicators

### `/inspect screenshot`

1. Navigate to `http://localhost:5173` if not already there
2. Use `browser_screenshot` to capture the page
3. Display the screenshot

### `/inspect click <element>`

1. Use `browser_snapshot` to find the element
2. Use `browser_click` to click it
3. Use `browser_snapshot` again to report updated state

### `/inspect check`

1. Navigate to `http://localhost:5173`
2. Fetch `http://localhost:5173/__api/debug` via WebFetch
3. Verify: model loaded, no critical errors, FPS > 0
4. Report pass/fail with details

### Error handling

- Playwright not available: suggest installing `npx @playwright/mcp@latest`
- Navigation fails: dev server not running, suggest `/dev`
