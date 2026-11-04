// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

//! Dev-server endpoint `POST /__api/dev/golden` (plan-615 F4): the dev
//! toolbar's "Save snapshot" writes `viewer.collectStateSnapshot()` as a state
//! golden to `e2e/__goldens__/<spec>/<step>.json`.
//!
//! Registered by `vite.config.ts` with `apply: 'serve'` only — no build carries
//! it. Every path decision is made HERE, server-side, on the normalised path:
//!
//!  - the name is `<spec>/<step>` (more segments allowed), optionally ending in
//!    `.json`; any other extension is refused;
//!  - no absolute path, no drive letter, no backslash, no `.`/`..` segment, no
//!    empty segment, only `[A-Za-z0-9_-]` plus inner dots in a segment;
//!  - the resolved file must lie inside `<root>/e2e/__goldens__/`;
//!  - an existing file is only replaced with `overwrite: true` (409 otherwise).
//!
//! The on-disk form is the canonical one of `e2e/_golden.ts` (`serializeGolden`).
//! It is repeated here because that module imports `playwright/test` and is not
//! part of a staged workspace; `tests/dev-snapshot-endpoint.node.test.ts` pins
//! both to the same output.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';

/** The goldens root, relative to the served project root. */
export const GOLDEN_DIR_REL = 'e2e/__goldens__';

/** Route of the endpoint. */
export const DEV_GOLDEN_ROUTE = '/__api/dev/golden';

/** Largest accepted request body (a snapshot is a few KB; 5 MB is generous). */
export const DEV_GOLDEN_MAX_BODY = 5 * 1024 * 1024;

const SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

//! The canonical on-disk form: one key per line, trailing newline (= e2e/_golden.ts).
export function serializeGolden(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

//! Resolves a golden name to its file below `<root>/e2e/__goldens__/`, or an error.
export function resolveGoldenTarget(root, name) {
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'name is required' };
  const raw = name.trim();
  if (raw.includes('\\')) return { ok: false, error: 'backslashes are not allowed' };
  if (raw.includes('\0')) return { ok: false, error: 'invalid character' };
  if (raw.startsWith('/') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: 'absolute paths are not allowed' };
  }
  const base = raw.toLowerCase().endsWith('.json') ? raw.slice(0, -5) : raw;
  const segments = base.split('/');
  if (segments.length < 2) return { ok: false, error: 'name must be <spec>/<step>' };
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, error: 'empty, "." and ".." segments are not allowed' };
    }
    if (!SEGMENT.test(segment)) return { ok: false, error: `invalid segment "${segment}"` };
  }
  // A dot left in the last segment is a foreign extension (`step.txt`).
  if (segments[segments.length - 1].includes('.')) return { ok: false, error: 'only .json goldens are allowed' };

  const goldenRoot = resolve(root, GOLDEN_DIR_REL);
  const file = resolve(goldenRoot, `${segments.join('/')}.json`);
  const rel = relative(goldenRoot, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'path leaves e2e/__goldens__' };
  }
  return { ok: true, file, rel: `${GOLDEN_DIR_REL}/${rel.split(sep).join('/')}` };
}

//! Writes a golden. Returns `{ ok, status, path }` or `{ ok: false, status, error }`.
export function writeGolden(root, name, value, options = {}) {
  const target = resolveGoldenTarget(root, name);
  if (!target.ok) return { ok: false, status: 400, error: target.error };
  if (value === undefined) return { ok: false, status: 400, error: 'snapshot is required' };
  if (existsSync(target.file) && options.overwrite !== true) {
    return { ok: false, status: 409, error: `${target.rel} exists — tick "overwrite" to replace it`, path: target.rel };
  }
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, serializeGolden(value), 'utf8');
  return { ok: true, status: 200, path: target.rel };
}

function sendJson(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

//! Connect middleware for the endpoint. `root` is the served project root.
export function devGoldenMiddleware(root) {
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== DEV_GOLDEN_ROUTE) { next(); return; }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return; }
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > DEV_GOLDEN_MAX_BODY) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) { sendJson(res, 413, { ok: false, error: 'body too large' }); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { ok: false, error: 'invalid JSON' }); return; }
      if (!parsed || typeof parsed !== 'object') { sendJson(res, 400, { ok: false, error: 'invalid body' }); return; }
      try {
        const result = writeGolden(root, parsed.name, parsed.snapshot, { overwrite: parsed.overwrite === true });
        const { status, ...data } = result;
        sendJson(res, status, data);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    });
  };
}

//! Absolute path of the goldens root for `root` (for messages and tests).
export function goldenRootOf(root) {
  return join(resolve(root), GOLDEN_DIR_REL);
}
