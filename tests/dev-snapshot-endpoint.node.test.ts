// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-615 §9.4 — the dev-server golden writer `POST /__api/dev/golden`
 * (`scripts/lib/rv-dev-golden.mjs`).
 *
 * Writes ONLY below `e2e/__goldens__/`; `..`, absolute paths and foreign
 * extensions are refused; without the overwrite flag an existing file is
 * never replaced; the on-disk form is exactly `serializeGolden` of
 * `e2e/_golden.ts`; vite.config.ts registers it for `serve` only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  DEV_GOLDEN_ROUTE, devGoldenMiddleware, resolveGoldenTarget, serializeGolden, writeGolden,
} from '../scripts/lib/rv-dev-golden.mjs';
import { serializeGolden as e2eSerializeGolden } from '../e2e/_golden';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-dev-golden-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const goldenFile = (rel: string) => join(root, 'e2e', '__goldens__', rel);

describe('resolveGoldenTarget — path confinement', () => {
  it('Test_Resolve_SpecStep_LandsBelowGoldens', () => {
    const t = resolveGoldenTarget(root, 'golden-pilot/start');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.file).toBe(resolve(goldenFile('golden-pilot/start.json')));
    expect(t.rel).toBe('e2e/__goldens__/golden-pilot/start.json');
  });

  it('Test_Resolve_ExplicitJsonExtension_Accepted', () => {
    const t = resolveGoldenTarget(root, 'spec/step.json');
    expect(t.ok && t.rel).toBe('e2e/__goldens__/spec/step.json');
  });

  it.each([
    ['../escape/x', 'dot-dot at start'],
    ['spec/../../x', 'dot-dot inside'],
    ['spec/./x', 'dot segment'],
    ['spec//x', 'empty segment'],
    ['/abs/x', 'posix absolute'],
    ['C:/abs/x', 'drive letter'],
    ['C:x/y', 'drive-relative'],
    ['spec\\x', 'backslash'],
    ['spec/x.txt', 'foreign extension'],
    ['spec/x.json.bak', 'foreign extension after json'],
    ['spec/x.JS', 'foreign extension (case)'],
    ['onlystep', 'missing spec'],
    ['', 'empty'],
    ['spec/x y', 'space'],
    ['spec/.hidden', 'leading dot'],
  ])('Test_Resolve_Rejects_%s (%s)', (name) => {
    expect(resolveGoldenTarget(root, name).ok).toBe(false);
  });

  it('Test_Resolve_NonString_Rejected', () => {
    expect(resolveGoldenTarget(root, 42 as unknown as string).ok).toBe(false);
    expect(resolveGoldenTarget(root, undefined as unknown as string).ok).toBe(false);
  });
});

describe('writeGolden — canonical form and overwrite guard', () => {
  it('Test_Write_NewGolden_CanonicalForm', () => {
    const value = { drives: { B: 2, A: 1 }, list: [1, 2] };
    const r = writeGolden(root, 'spec/step', value);
    expect(r).toEqual({ ok: true, status: 200, path: 'e2e/__goldens__/spec/step.json' });
    expect(readFileSync(goldenFile('spec/step.json'), 'utf8')).toBe(e2eSerializeGolden(value));
  });

  it('Test_SerializeGolden_IdenticalToE2eHelper', () => {
    const value = { a: [1, { b: 'x' }], c: null, d: 0.5 };
    expect(serializeGolden(value)).toBe(e2eSerializeGolden(value));
  });

  it('Test_Write_ExistingWithoutOverwrite_RefusedAndUntouched', () => {
    mkdirSync(join(root, 'e2e', '__goldens__', 'spec'), { recursive: true });
    writeFileSync(goldenFile('spec/step.json'), 'ORIGINAL', 'utf8');
    const r = writeGolden(root, 'spec/step', { x: 1 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(readFileSync(goldenFile('spec/step.json'), 'utf8')).toBe('ORIGINAL');
  });

  it('Test_Write_ExistingWithOverwrite_Replaced', () => {
    mkdirSync(join(root, 'e2e', '__goldens__', 'spec'), { recursive: true });
    writeFileSync(goldenFile('spec/step.json'), 'ORIGINAL', 'utf8');
    const r = writeGolden(root, 'spec/step', { x: 1 }, { overwrite: true });
    expect(r.ok).toBe(true);
    expect(readFileSync(goldenFile('spec/step.json'), 'utf8')).toBe(serializeGolden({ x: 1 }));
  });

  it('Test_Write_RejectedPath_WritesNothing', () => {
    const r = writeGolden(root, '../../outside', { x: 1 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(existsSync(join(root, 'outside.json'))).toBe(false);
    expect(existsSync(join(root, 'e2e'))).toBe(false);
  });

  it('Test_Write_MissingSnapshot_Rejected', () => {
    expect(writeGolden(root, 'spec/step', undefined).status).toBe(400);
  });
});

/** Minimal req/res pair for the connect middleware. */
function call(method: string, url: string, body: string | null) {
  const req = Object.assign(new EventEmitter(), { method, url });
  const out: { status?: number; body?: string; nextCalled: boolean } = { nextCalled: false };
  const res = {
    setHeader: () => undefined,
    writeHead: (s: number) => { out.status = s; },
    end: (b: string) => { out.body = b; },
  };
  const done = new Promise<typeof out>((resolveDone) => {
    const mw = devGoldenMiddleware(root);
    const origEnd = res.end;
    res.end = (b: string) => { origEnd(b); resolveDone(out); };
    mw(req, res, () => { out.nextCalled = true; resolveDone(out); });
    if (body !== null) { req.emit('data', body); req.emit('end'); }
  });
  return done;
}

describe('devGoldenMiddleware', () => {
  it('Test_Middleware_OtherRoute_PassesThrough', async () => {
    const r = await call('POST', '/__api/debug/snapshot', null);
    expect(r.nextCalled).toBe(true);
  });

  it('Test_Middleware_Get_Is405', async () => {
    const r = await call('GET', DEV_GOLDEN_ROUTE, null);
    expect(r.status).toBe(405);
  });

  it('Test_Middleware_ValidPost_Writes', async () => {
    const r = await call('POST', DEV_GOLDEN_ROUTE, JSON.stringify({ name: 'spec/a', snapshot: { v: 1 } }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body!)).toEqual({ ok: true, path: 'e2e/__goldens__/spec/a.json' });
    expect(existsSync(goldenFile('spec/a.json'))).toBe(true);
  });

  it('Test_Middleware_TraversalPost_Is400', async () => {
    const r = await call('POST', DEV_GOLDEN_ROUTE, JSON.stringify({ name: '../x/y', snapshot: {} }));
    expect(r.status).toBe(400);
  });

  it('Test_Middleware_Conflict_Is409_OverwriteFlagMustBeTrue', async () => {
    await call('POST', DEV_GOLDEN_ROUTE, JSON.stringify({ name: 'spec/a', snapshot: { v: 1 } }));
    const truthy = await call('POST', DEV_GOLDEN_ROUTE, JSON.stringify({ name: 'spec/a', snapshot: { v: 2 }, overwrite: 'yes' }));
    expect(truthy.status).toBe(409);
    expect(JSON.parse(readFileSync(goldenFile('spec/a.json'), 'utf8'))).toEqual({ v: 1 });
  });

  it('Test_Middleware_InvalidJson_Is400', async () => {
    const r = await call('POST', DEV_GOLDEN_ROUTE, '{nope');
    expect(r.status).toBe(400);
  });
});

describe('vite.config.ts wiring', () => {
  const src = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

  it('Test_ViteConfig_RegistersDevGoldenPlugin_ServeOnly', () => {
    const start = src.indexOf('function devGoldenPlugin()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain("apply: 'serve' as const");
    expect(body).toContain('devGoldenMiddleware(');
    expect(src).toContain('devGoldenPlugin(),');
  });
});
