// plan-659 follow-up — does the keyboard need a click in the 3D view first?
//
// The plate is about to TELL the operator how the robot is steered, so every
// sentence on it has to be true. The one claim nobody can settle by reading the
// code is the focus rule: the listeners sit on `window` and bail out only for a
// focused text field, which SAYS that any focus inside the page works — but a
// focused MUI button also consumes Space and a slider consumes the arrow keys,
// so the plate itself could be eating the keys the legend advertises.
//
// Three focus situations, one answer each — and REAL key events
// (`page.keyboard`), which go to the focused element, not the synthetic
// `window.dispatchEvent` the other diags use:
//
//   untouched — nothing clicked since the page loaded
//   canvas    — the 3D view clicked (what a user does anyway)
//   panel     — a control on the plate focused (the DRIVE knob)
//
// While a movement key is held the plugin's steering writes `vx`/`vy`/`yaw`
// every tick, so a non-zero `RobotCmdYaw` is proof the key arrived.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5659/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659';

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-welcome-dismissed', '1');
    localStorage.setItem('rv-auto-quality-applied', '1');
  } catch { /* ignore */ }
});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120_000 });
await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180_000 });
try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch { /* ignore */ }
await page.waitForTimeout(2000);

const read = () => page.evaluate(() => {
  const s = window.__rvMuJoCo.signals();
  return { vx: s.RobotCmdVx, vy: s.RobotCmdVy, yaw: s.RobotCmdYaw, recovering: s.RobotRecovering };
});

const pushCount = () => page.evaluate(() => window.__rvMuJoCo.pushDiag().count);

/** Holds a key for a moment and reports what the command signals did. */
async function holdKey(key, ms = 1200) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  const held = await read();
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
  return { held, released: await read() };
}

/** Presses SPACE once and reports whether the robot was actually shoved. */
async function pressSpace() {
  const before = await pushCount();
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  return { pushCountBefore: before, pushCountAfter: await pushCount() };
}

const active = () => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName}[${el.getAttribute('role') ?? ''}]` : null;
});

const probes = {};

// 1. untouched — the page has never been clicked.
probes.untouched = { activeElement: await active(), w: await holdKey('w'), space: await pressSpace() };

// 2. the 3D view clicked.
await page.mouse.click(1100, 500);
probes.canvas = { activeElement: await active(), w: await holdKey('w'), space: await pressSpace() };

// 3. a control on the plate focused — a REAL control owning the keyboard.
await page.evaluate(() => {
  const win = [...document.querySelectorAll('[data-ui-panel]')].find((p) => /robot/i.test(p.textContent || ''));
  const radio = win?.querySelector('[role="radio"]');
  (radio instanceof HTMLElement ? radio : null)?.focus();
});
probes.panel = {
  activeElement: await active(),
  w: await holdKey('w'),
  // SPACE on a focused control is the interesting one: it is both the push
  // command and the browser's "activate this control".
  space: await pressSpace(),
};

writeFileSync(resolve(HERE, 'followup-keyboard-focus.json'), `${JSON.stringify(probes, null, 2)}\n`);
console.log(JSON.stringify(probes, null, 2));
await browser.close();
