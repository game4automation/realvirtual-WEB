// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * shipped-asset-references — no GLB under `public/` may reference another asset
 * by an ABSOLUTE url.
 *
 * An `AssetReference.path` is resolved against the deploy root, so the
 * project-relative form (`library/PalletHandling/ChainConveyor-1m.glb`) works on
 * every channel: the dev server, a `/dev/` deploy, the public demo, a customer
 * workspace, `file://`. An absolute one (`http://localhost:5173/library/...`)
 * works on exactly the machine that authored it.
 *
 * This is not hypothetical. `DemoPlanner.glb` shipped with two of its fifteen
 * placements carrying `http://localhost:5173/...`, written by a planner save in
 * a dev session. Nobody noticed, because the authoring machine kept a Vite dev
 * server on 5173 — CONNECT starts one as a child process — so the url happened
 * to resolve there. In the public `/dev/` build the two placements failed with
 * "Referenced asset not found" while their thirteen relative siblings loaded
 * fine, and because a Conveyor with no successor reads "downstream blocked",
 * the demo line stopped.
 *
 * That is the failure mode this guards: an absolute path is invisible on the
 * machine that produced it and only breaks for everyone else.
 *
 * A Node test rather than a browser one because it is a statement about FILES.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/** Every `*.glb` under `public/`, as repo-relative paths. */
function listGlbs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listGlbs(full, out);
    else if (entry.toLowerCase().endsWith('.glb')) out.push(full);
  }
  return out;
}

/**
 * The JSON chunk of a GLB, or null when the file is not a GLB we can read.
 * Deliberately tolerant: an unreadable file is not this test's finding.
 */
function readGlbJson(file: string): Record<string, unknown> | null {
  const buf = readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== CHUNK_JSON) return null;
  if (20 + jsonLen > buf.length) return null;
  try {
    return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface RefFinding {
  file: string;
  node: string;
  path: string;
}

/** Every `AssetReference.path` in the file that carries a scheme or is host-relative. */
function absoluteReferences(file: string, json: Record<string, unknown>): RefFinding[] {
  const nodes = (json.nodes ?? []) as Array<{
    name?: string;
    extras?: { realvirtual?: { AssetReference?: { path?: string } } };
  }>;
  const found: RefFinding[] = [];
  for (const node of nodes) {
    const path = node.extras?.realvirtual?.AssetReference?.path;
    if (typeof path !== 'string' || path === '') continue;
    // A scheme (`http:`, `https:`, `blob:`, `file:`), a protocol-relative url
    // (`//host/...`) or a host-absolute path (`/library/...`) all pin the
    // reference to one origin or one deploy root.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('/')) {
      found.push({ file: relative(ROOT, file), node: node.name ?? '(unnamed)', path });
    }
  }
  return found;
}

describe('shipped GLBs reference their assets relatively', () => {
  it('no AssetReference.path under public/ carries an origin or a leading slash', () => {
    const findings = listGlbs(PUBLIC_DIR).flatMap((file) => {
      const json = readGlbJson(file);
      return json ? absoluteReferences(file, json) : [];
    });

    const report = findings
      .map((f) => `  ${f.file}  node ${JSON.stringify(f.node)}\n    ${f.path}`)
      .join('\n');

    expect(
      findings,
      findings.length === 0
        ? ''
        : `Absolute AssetReference path(s) in shipped GLB(s) — these resolve only on the ` +
            `machine that authored them and break every other deploy:\n${report}\n\n` +
            `Store the project-relative path instead, e.g. ` +
            `"library/PalletHandling/ChainConveyor-1m.glb".`,
    ).toEqual([]);
  });
});
