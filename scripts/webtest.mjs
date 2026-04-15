/**
 * webtest.mjs — Launch a visible Playwright browser, load the WebViewer with debug=all,
 * and capture console output for a configurable duration.
 *
 * Usage:
 *   node scripts/webtest.mjs                          # defaults: tests.glb, 10s
 *   node scripts/webtest.mjs --model demo.glb         # specific model
 *   node scripts/webtest.mjs --duration 20            # run for 20 seconds
 *   node scripts/webtest.mjs --debug playback,loader  # specific debug categories
 *   node scripts/webtest.mjs --headless               # headless mode (no visible window)
 *   node scripts/webtest.mjs --port 5177              # custom port
 *   node scripts/webtest.mjs --reuse                  # reuse persistent browser (no new Chrome)
 */

import { chromium } from 'playwright';

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  if (idx + 1 < args.length && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return defaultVal;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const model = getArg('model', 'tests.glb');
const duration = parseInt(getArg('duration', '10'), 10) * 1000;
const debugCategories = getArg('debug', 'all');
const headless = hasFlag('headless');
const port = getArg('port', '5173');
const baseUrl = `http://localhost:${port}`;

// --- Color codes for console output ---
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function colorize(type, text) {
  switch (type) {
    case 'error': return `${RED}[ERROR]${RESET} ${text}`;
    case 'warning': return `${YELLOW}[WARN]${RESET}  ${text}`;
    case 'info': return `${CYAN}[INFO]${RESET}  ${text}`;
    case 'debug': return `${DIM}[DEBUG]${RESET} ${text}`;
    case 'log':
    default: return `${GREEN}[LOG]${RESET}   ${text}`;
  }
}

// --- Main ---
console.log(`\n${MAGENTA}=== realvirtual WebTest ===${RESET}`);
console.log(`  Model:    ${model}`);
console.log(`  Debug:    ${debugCategories}`);
console.log(`  Duration: ${duration / 1000}s`);
console.log(`  Mode:     ${headless ? 'headless' : 'visible'}`);
console.log(`  URL:      ${baseUrl}`);
console.log('');

// Check if dev server is running
try {
  const resp = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
} catch (e) {
  console.error(`${RED}Dev server not running at ${baseUrl}${RESET}`);
  console.error(`Start it first: cd Assets/realvirtual-WebViewer~ && npm run dev`);
  process.exit(1);
}

const reuse = hasFlag('reuse');
let browser, context, page;

if (reuse) {
  // Reuse a persistent browser profile — avoids opening a new Chrome each time
  const userDataDir = '.playwright-profile';
  context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: headless ? [] : ['--start-maximized'],
    viewport: headless ? { width: 1280, height: 720 } : null,
  });
  // Close all existing pages and open a fresh one
  for (const p of context.pages()) await p.close();
  page = await context.newPage();
  browser = null; // persistent context manages itself
} else {
  browser = await chromium.launch({
    headless,
    args: headless ? [] : ['--start-maximized'],
  });
  context = await browser.newContext({
    viewport: headless ? { width: 1280, height: 720 } : null,
  });
  page = await context.newPage();
}

// Collect logs
const logs = [];
let loadComplete = false;

page.on('console', (msg) => {
  const text = msg.text();
  const type = msg.type();
  const line = colorize(type, text);
  logs.push({ type, text, time: Date.now() });
  console.log(line);

  // Detect load completion
  if (text.includes('drives') && text.includes('sensors') && text.includes('erratic')) {
    loadComplete = true;
  }
});

page.on('pageerror', (err) => {
  const line = colorize('error', `PAGE ERROR: ${err.message}`);
  logs.push({ type: 'pageerror', text: err.message, time: Date.now() });
  console.log(line);
});

// Navigate with debug params
// Entry URLs use ./models/filename.glb format (from Vite glob)
const modelPath = model.startsWith('./') ? model : `./models/${model.replace(/^\/models\//, '')}`;
const url = `${baseUrl}/?debug=${debugCategories}&model=${encodeURIComponent(modelPath)}`;
console.log(`${DIM}Navigating to: ${url}${RESET}\n`);

await page.goto(url, { timeout: 30000 });

// Wait a moment for initial page load, then try to select model if not auto-loaded
await page.waitForTimeout(2000);

if (!loadComplete) {
  // Try to find and select the model from the dropdown
  const selected = await page.evaluate((modelName) => {
    const sel = document.querySelector('#modelSelect');
    if (!sel) return null;
    const options = Array.from(sel.options);
    const match = options.find(o => o.value.includes(modelName.replace('.glb', '')));
    if (match) {
      sel.value = match.value;
      sel.dispatchEvent(new Event('change'));
      return match.value;
    }
    return options.map(o => o.value).join(', ');
  }, model);

  if (selected) {
    console.log(`${DIM}Selected model via dropdown: ${selected}${RESET}\n`);
  }
}

// Wait for the configured duration
console.log(`${DIM}--- Capturing for ${duration / 1000}s ---${RESET}\n`);
await page.waitForTimeout(duration);

// Summary
console.log(`\n${MAGENTA}=== Summary ===${RESET}`);
const errors = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
const warnings = logs.filter(l => l.type === 'warning' && !l.text.includes('GL Driver'));
const parity = logs.filter(l => l.text.includes('[Parity]'));

console.log(`  Total logs:    ${logs.length}`);
console.log(`  Errors:        ${errors.length > 0 ? RED : GREEN}${errors.length}${RESET}`);
console.log(`  Warnings:      ${warnings.length > 0 ? YELLOW : GREEN}${warnings.length}${RESET}`);
console.log(`  Parity issues: ${parity.length > 0 ? YELLOW : GREEN}${parity.length}${RESET}`);
console.log(`  Load complete: ${loadComplete ? GREEN + 'yes' : RED + 'no'}${RESET}`);

if (parity.length > 0) {
  console.log(`\n${YELLOW}Parity warnings:${RESET}`);
  for (const p of parity) {
    console.log(`  ${p.text}`);
  }
}

if (errors.length > 0) {
  console.log(`\n${RED}Errors:${RESET}`);
  for (const e of errors) {
    console.log(`  ${e.text}`);
  }
}

if (browser) await browser.close();
else await context.close();

// Exit with error code if there were errors
process.exit(errors.length > 0 ? 1 : 0);
