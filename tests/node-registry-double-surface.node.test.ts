// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-900 A2 guard, the sibling of `mode-manager-double-surface`: the shared
 * NodeRegistry double must carry every member reached through
 * `viewer.registry.*` in public or private viewer source, and every such member
 * must really belong to `NodeRegistry`.
 *
 * ## Why the receiver is spelled out
 *
 * The ModeManager rule can scan for a bare `.modes.` because that property name
 * is almost unique. `.registry.` is not: component registries, the UI registry
 * and several plugin-local registries all answer to it, and a scan that coarse
 * would demand ~60 unrelated members of this double. So the pattern is anchored
 * on the receiver `viewer` — which is exactly the receiver a viewer double
 * stands in for. A member reached through a local alias
 * (`const r = viewer.registry; r.foo()`) escapes it; none exists today
 * (`scene-store.ts` aliases the registry but takes only modelled members
 * through it, which the surface count below would notice going stale). If one
 * appears, extend the rule rather than weaken the invariant.
 *
 * Known limitation, shared with the ModeManager rule: destructuring and
 * computed access are invisible to a dot-access scan.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRegistryDouble } from './fixtures/node-registry-double';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const scannedFiles = [
  ...walk(join(root, 'src')),
  ...walk(resolve(root, '..', 'realvirtual-WebViewer-Private~', 'src')),
].sort();

const surface = new Set<string>();
for (const file of scannedFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/viewer\.registry\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    surface.add(match[1]);
  }
}

/**
 * The bake's two members, reached through a local `registry` alias in
 * `scene-store.ts` rather than through `viewer.registry` directly. Listed here
 * because they are the whole reason the four inline doubles existed at all —
 * leaving them out would let the double drop them and still pass.
 */
const ALIASED = ['getGltfNodeNames', 'getGltfNodeIndex'] as const;
for (const member of ALIASED) surface.add(member);

const registrySource = readFileSync(join(root, 'src', 'core', 'engine', 'rv-node-registry.ts'), 'utf8');
const classStart = registrySource.indexOf('export class NodeRegistry {');
const afterClassStart = registrySource.slice(classStart);
const classEnd = afterClassStart.search(/^}\r?$/m);
const classSource = classStart >= 0 && classEnd >= 0 ? afterClassStart.slice(0, classEnd) : '';
const classMembers = new Set<string>();
const declaration = /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:(?:async|get|set)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|=|:|<)/gm;
for (const match of classSource.matchAll(declaration)) classMembers.add(match[1]);

const doubleKeys = new Set(Reflect.ownKeys(nodeRegistryDouble()).map(String));

const names = (values: Iterable<string>) => [...values].sort().join(', ');

describe('plan-900 shared NodeRegistry double surface', () => {
  it('scans a plausible source surface', () => {
    // A wrong glob otherwise yields an empty surface and a passing invariant.
    expect(scannedFiles.length, `scanned only ${scannedFiles.length} TypeScript source files`)
      .toBeGreaterThan(200);
    expect(surface.size, `found only ${surface.size} distinct viewer.registry.* members`)
      .toBeGreaterThanOrEqual(20);
  });

  it('reads the real NodeRegistry class', () => {
    // Guards the extraction itself: a renamed class or a reformatted body would
    // otherwise empty `classMembers` and make the next two assertions vacuous.
    expect(classStart, 'export class NodeRegistry { not found').toBeGreaterThanOrEqual(0);
    expect(classMembers.size, `extracted only ${classMembers.size} NodeRegistry members`)
      .toBeGreaterThan(50);
  });

  it('every scanned viewer.registry.* member exists on the real NodeRegistry', () => {
    const missing = [...surface].filter((member) => !classMembers.has(member));
    expect(missing, `not declared on NodeRegistry: ${names(missing)}`).toEqual([]);
  });

  it('every scanned viewer.registry.* member is present on the shared double', () => {
    const missing = [...surface].filter((member) => !doubleKeys.has(member));
    expect(missing, `missing from nodeRegistryDouble: ${names(missing)}`).toEqual([]);
  });

  it('the double carries no unexplained extras', () => {
    const unexplained = [...doubleKeys].filter(
      (key) => !surface.has(key) && !classMembers.has(key),
    );
    expect(unexplained, `unexplained nodeRegistryDouble keys: ${names(unexplained)}`).toEqual([]);
  });
});
