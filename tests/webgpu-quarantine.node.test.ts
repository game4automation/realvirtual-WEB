// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * webgpu-quarantine.node.test.ts — plan-602 F10: the WebGPU quarantine list
 * `tests/webgpu-quarantine.json` (read by `tests/helpers/quarantine.ts`).
 *
 *  - `webgpuQuarantine` EQUALS `QUARANTINE_BASELINE` — the transitions are tested on the
 *    pure check: remove from the list only → red, remove from both → green, re-add a
 *    removed id to the list only → red, a brand-new id → red.
 *  - Every entry carries a cause and a complete `observedOn` (gpu, driver, browser,
 *    launchArgs, date) — where the failure was classified.
 *  - Every `quarantinedIt('<id>'` in a test file is listed under ITS file, and every listed
 *    id has exactly one such call (private entries only with the private sibling present).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QuarantineEntry } from './helpers/quarantine';

/**
 * F10 — the quarantine baseline. THIS LIST MAY ONLY LOSE ENTRIES. Removing an id here (in the
 * same change that removes it from `webgpuQuarantine` because the test passes now) is the
 * intended path; adding or re-adding one means a reviewer sees this list grow. Initially the
 * eight tests that failed with GPU flags on 2026-10-14/15 (plan-602 § 6a → plan-763); EMPTY since
 * 2026-10-17 — with a real WebGPU device (plan-763) seven passed and the eighth was fixed.
 * That observation REQUIRES the full Chromium build: `launchOptions.channel = GPU_BROWSER_CHANNEL`
 * ('chromium') in vitest.gpu.config.ts (commit b748d034). Playwright's default chrome-headless-shell
 * lacks dxil.dll / dxcompiler.dll, so Dawn cannot create a device and three falls back to WebGL2.
 * Reverting the channel turns these tests red again; the cause is then the browser binary, not the tests.
 * `<private>` stands for the `../<private sibling>` prefix the list uses (taken from the list, so
 * this file names no private path and keeps running in the community edition, where the
 * private entries are simply not checked on disk).
 */
const QUARANTINE_BASELINE_RAW: readonly string[] = [];

/** Problems of a quarantine list against its baseline — empty when they are equal (F10). */
function checkQuarantineBaseline(listIds: readonly string[], baseline: readonly string[]): string[] {
  const problems: string[] = [];
  if (JSON.stringify([...listIds].sort()) !== JSON.stringify([...listIds])) problems.push('webgpuQuarantine is not sorted by id');
  if (new Set(listIds).size !== listIds.length) problems.push('webgpuQuarantine has duplicate ids');
  const base = new Set(baseline);
  const list = new Set(listIds);
  for (const id of list) if (!base.has(id)) problems.push(`not in QUARANTINE_BASELINE (the list may only shrink): ${id}`);
  for (const id of base) if (!list.has(id)) problems.push(`in QUARANTINE_BASELINE but not in webgpuQuarantine — remove it from the baseline in the same change: ${id}`);
  return problems;
}

const ROOT = resolve(__dirname, '..');
const LIST: { webgpuQuarantine: QuarantineEntry[] } = JSON.parse(readFileSync(resolve(ROOT, 'tests/webgpu-quarantine.json'), 'utf8'));
/** `../<private sibling>` as the list spells it. */
const PRIVATE_PREFIX = LIST.webgpuQuarantine.map((e) => e.id).find((id) => id.startsWith('../'))?.split('/').slice(0, 2).join('/') ?? '../private';
const QUARANTINE_BASELINE = QUARANTINE_BASELINE_RAW.map((id) => id.replace(/^<private>/, PRIVATE_PREFIX));
const fileOf = (id: string): string => id.split(' :: ')[0];
/** `../<sibling>` of a private entry; its presence decides whether private entries are checked. */
const siblingOf = (f: string): string => f.split('/').slice(0, 2).join('/');
const available = (f: string): boolean => !f.startsWith('../') || existsSync(resolve(ROOT, siblingOf(f)));

/** All browser test files under `<dir>` (recursive), relative to ROOT with `/`. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...testFiles(p)); continue; }
    if (/\.test\.tsx?$/.test(e.name) && !/\.node\.test\.ts$/.test(e.name)) out.push(relative(ROOT, p).replace(/\\/g, '/'));
  }
  return out;
}

describe('tests/webgpu-quarantine.json', () => {
  it('webgpuQuarantine equals QUARANTINE_BASELINE (F10: may only shrink)', () => {
    expect(checkQuarantineBaseline(LIST.webgpuQuarantine.map((e) => e.id), QUARANTINE_BASELINE)).toEqual([]);
    for (const e of LIST.webgpuQuarantine) {
      expect(e.cause, `${e.id} cause`).toMatch(/\S/);
      if (available(fileOf(e.id))) expect(existsSync(resolve(ROOT, fileOf(e.id))), `${fileOf(e.id)} exists`).toBe(true);
    }
  });

  it('every entry records where it was observed (observedOn is mandatory)', () => {
    for (const e of LIST.webgpuQuarantine) {
      const o = e.observedOn;
      expect(o, `${e.id} observedOn`).toBeDefined();
      for (const key of ['gpu', 'driver', 'browser', 'date'] as const) {
        expect(typeof o?.[key] === 'string' && /\S/.test(o[key]), `${e.id} observedOn.${key}`).toBe(true);
      }
      expect(o!.date, `${e.id} observedOn.date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(o!.launchArgs) && o!.launchArgs.every((a) => typeof a === 'string'), `${e.id} observedOn.launchArgs`).toBe(true);
    }
  });

  it('F10 transitions on the pure check (no git): remove list-only → red, both → green, re-add list-only → red', () => {
    const base = ['a :: s > one', 'b :: s > two'];
    expect(checkQuarantineBaseline(base, base)).toEqual([]);
    // removed from the list only — the baseline still names it
    expect(checkQuarantineBaseline(['a :: s > one'], base).join('\n')).toMatch(/in QUARANTINE_BASELINE but not in webgpuQuarantine.*two/);
    // removed from both in the same change
    expect(checkQuarantineBaseline(['a :: s > one'], ['a :: s > one'])).toEqual([]);
    // re-added to the list without touching the (shrunk) baseline
    expect(checkQuarantineBaseline(base, ['a :: s > one']).join('\n')).toMatch(/not in QUARANTINE_BASELINE.*two/);
    // a brand-new id
    expect(checkQuarantineBaseline([...base, 'c :: s > three'], base).join('\n')).toMatch(/not in QUARANTINE_BASELINE.*three/);
    expect(checkQuarantineBaseline(['b :: s > two', 'a :: s > one'], base).join('\n')).toMatch(/not sorted/);
    expect(checkQuarantineBaseline([...base, 'b :: s > two'], base).join('\n')).toMatch(/duplicate/);
  });

  it('every quarantinedIt call is listed under its own file, and every listed id has exactly one call', () => {
    const privateTests = LIST.webgpuQuarantine.map((e) => fileOf(e.id)).filter((f) => f.startsWith('../'));
    const roots = [resolve(ROOT, 'tests'), ...new Set(privateTests.map((f) => resolve(ROOT, siblingOf(f), 'tests')))];
    const calls = new Map<string, string[]>();
    for (const file of roots.flatMap(testFiles)) {
      if (file.startsWith('tests/fixtures/quarantine/')) continue; // the helper's own fixtures (createQuarantinedIt)
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of source.matchAll(/\bquarantinedIt\(\s*'([^']+)'/g)) {
        expect(fileOf(m[1]), `quarantinedIt in ${file} names another file`).toBe(file);
        calls.set(m[1], [...(calls.get(m[1]) ?? []), file]);
      }
    }
    const listed = LIST.webgpuQuarantine.map((e) => e.id);
    for (const id of calls.keys()) expect(listed, `quarantinedIt('${id}') is not in webgpuQuarantine`).toContain(id);
    for (const id of listed) {
      if (!available(fileOf(id))) continue;
      expect(calls.get(id)?.length ?? 0, `exactly one quarantinedIt call for ${id}`).toBe(1);
    }
  }, 60_000); // reads every test file of both repos — seconds alone, more under a parallel node run
});
