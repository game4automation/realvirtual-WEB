// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.11 / F8 (static half) — stored references are read by the file's
 * verdict, never through the runtime path index.
 *
 * Three rules, checked over the source text (fs walk, node mode):
 *
 *  1. **Components.** Every `.getNode(` / `.getByPath(` in a component module (a file
 *     that calls `registerComponent(`) or in a stored-reference plugin is on the
 *     allowlist below, with its class from Inventory R: `runtime` (a registry path the
 *     runtime computed itself), `legacy` (the path lookup a `readStoredRef` →
 *     `legacy` read falls back to), `group-prefix` (a group-name prefix, no path
 *     field), `intern` (registry bookkeeping), `doc` (prose). A NEW call fails until
 *     it is classified; an allowlisted call that disappeared fails too (stale entry).
 *  2. **Stored readers.** Every reader of Inventory R's `stored` class uses the
 *     stored-read API (`readStoredRef` / `storedNode` / `storedComponent` /
 *     `resolve(…, referrer)` / `resolveComponentRefs` / the zone's
 *     `resolveStaticCollider`).
 *  3. **Path writers.** The only engine code that writes a `ComponentReference.path`
 *     is the cell-matrix rescope, and only for a LEGACY asset (no migrated identity).
 *
 * The dynamic half for Phase 1 ("nothing migrated reaches a persisted position") is
 * `tests/file-untouched.test.ts`; the save-side walker is Phase 3 (9.5).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '..', 'realvirtual-WebViewer-Private~');

type CallClass = 'runtime' | 'legacy' | 'group-prefix' | 'intern' | 'doc';

/**
 * file → [line substring, class, why]. One entry per CALL (a substring that occurs
 * twice in a file needs two entries).
 */
const ALLOWLIST: Record<string, ReadonlyArray<readonly [string, CallClass, string]>> = {
  'src/core/engine/rv-connect-signal.ts': [
    ["this._store?.getByPath(this._sourceAddr ?? '')", 'runtime', 'SignalStore lookup of a resolved signal address, not the registry'],
  ],
  'src/core/engine/rv-drive-pulse-encoder.ts': [
    ["getByPath<RVDrive>('Drive', path)", 'runtime', "the drive on the encoder's OWN node (computeNodePath)"],
  ],
  'src/core/engine/rv-fmu.ts': [
    ['registry.getNode(containerPath)', 'intern', 'registers its own runtime Signals container'],
  ],
  'src/core/engine/rv-ik-path.ts': [
    ['registry.getByPath<T>(type, path)', 'legacy', 'resolveComp without referrer / the legacy read of storedComponent'],
    ['registry.getNode(path)', 'legacy', 'resolveComp without referrer / the legacy read of storedComponent'],
    ['registry.getByPath<T>(type, cur)', 'legacy', 'resolveComp: the node\'s CURRENT registry path'],
  ],
  'src/core/engine/rv-machining-volume.ts': [
    ['registry.getNode(prefix)', 'group-prefix', 'GroupNamePrefix — a name prefix, not a path field'],
  ],
  'src/core/engine/rv-mu-switcher.ts': [
    ["registry.getByPath<RVSensor>('Sensor', path)", 'runtime', "the sensor on the switcher's OWN node (getPathForNode), plan-2016 S5"],
  ],
  'src/core/engine/rv-physics-zone.ts': [
    ['resolved via `registry.getNode(path)` with a', 'doc', 'field doc comment'],
    ["getByPath<{ refreshBounds?: RVPhysicsZone['refreshBounds'] }>('WebPhysicsZone2D', path)", 'runtime', 'the 2D zone on the same EDITED node (editor live hook, plan-661)'],
    ["registry.getByPath<RVPhysicsZone>('WebPhysicsZone', path)", 'runtime', 'the zone on an EDITED node (editor live hook)'],
    ['public `registry.getNode(path)` — NOT via resolveComponentRefs', 'doc', 'module doc comment'],
  ],
  'src/core/engine/rv-ribbon-roller.ts': [
    ["getByPath<RVDrive>('Drive', this._nodePath)", 'runtime', 'the drive on the roller\'s OWN node'],
  ],
  'src/core/engine/rv-sound.ts': [
    ["registry?.getByPath<SoundDriveLike>('Drive', this._path)", 'runtime', "the drive on the Sound's OWN node (path computed by the runtime)"],
    ["registry?.getByPath<SoundCylinderLike>('Drive_Cylinder', this._path)", 'runtime', "the Drive_Cylinder on the Sound's OWN node"],
  ],
  // plan-2227: the slots are resolved by resolveComponentRefs / registry.resolve (stored-read API);
  // what follows are lookups of those RESOLVED paths.
  'src/core/engine/rv-signal-connector.ts': [
    ['this._store?.getByPath(target)', 'runtime', 'SignalStore lookup of the resolved target address, not the registry'],
    ['this._store?.getByPath(this.sourcePath)', 'runtime', 'SignalStore lookup of the resolved source address (resync)'],
    ['this._store?.getByPath(this.sourcePath)', 'runtime', 'SignalStore lookup of the resolved source address (join word)'],
    ['this._store.getByPath(this.targetPath)', 'runtime', 'SignalStore lookup of the resolved target word (aggregator)'],
    ['reg?.getNode(targetPath)', 'runtime', 'the node of a target path the resolver produced, for its instance address (writer id)'],
  ],
  'src/core/engine/rv-source.ts': [
    ['context.registry.getNode(name)', 'legacy', 'the legacy read of storedNode(kind: name)'],
  ],
  'src/core/engine/rv-transport-surface.ts': [
    ['this._selRegistry?.getNode(p)', 'runtime', 'selection paths (registry paths of picked nodes)'],
    ["reg.getByPath('TransportSurface', path)", 'runtime', 'a node\'s own registry path'],
  ],
  'src/plugins/processindustry-plugin.ts': [
    ['const node = viewer.registry?.getNode(path);', 'legacy', 'resolveTank: after storedEndpoint answered legacy'],
    ['const node = viewer.registry?.getNode(path);', 'legacy', 'resolvePipe: after storedEndpoint answered legacy'],
    ['const node = viewer.registry?.getNode(path);', 'legacy', 'describeRef: log diagnostics only'],
  ],
  'src/plugins/connection-gizmo-plugin.ts': [
    ['registry.getNode(edge.source)', 'runtime', 'edge endpoints are canonical registry paths since the load (connection-system-plugin)'],
    ['registry.getNode(edge.target)', 'runtime', 'edge endpoints are canonical registry paths since the load (connection-system-plugin)'],
  ],
  'src/plugins/aas-link-plugin.tsx': [
    ['viewer?.registry?.getNode(nodePath)', 'runtime', 'the inspector node path of the selection'],
  ],
};

/** Inventory R `stored` class: must use the stored-read API. */
const STORED_READERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['src/core/engine/rv-custom-runtime-instruction.ts', /registry\.storedNode\(this\.node, path\)/],
  ['src/core/engine/rv-web-visibility.ts', /ctx\.registry\.storedNode\(this\.node, stored\)/],
  ['src/core/engine/rv-physics-zone.ts', /registry\.storedNode\(this\.node, path\)/],
  ['src/core/engine/rv-source.ts', /registry\.storedNode\(this\.node, this\.muName/],
  ['src/core/engine/rv-logic-engine.ts', /registry\.resolve\(ref, scope, node\)/],
  ['src/core/engine/rv-logic-engine.ts', /registry\.storedNode\(node, rawTarget as/],
  ['src/core/engine/rv-logic-engine.ts', /registry\.storedComponent<RVGrip>\(node, ref, 'Grip'\)/],
  ['src/core/engine/rv-logic-engine.ts', /registry\.storedComponent<RVIKPath>\(node, ref, 'IKPath'\)/],
  ['src/core/engine/rv-ik-path.ts', /registry\.storedComponent<T>\(referrer, path, type/],
  ['src/core/engine/rv-ik-target.ts', /storedComponent<RVGrip>\(this\.node, raw\.gripTarget, 'Grip'/],
  ['src/core/engine/rv-robot-ik.ts', /this\._registry\.storedNode\(this\.node, stored\)/],
  ['src/core/engine/rv-machining-volume.ts', /registry\.storedNode\(this\.node, entry\)/],
  ['src/core/engine/rv-component-registry.ts', /registry\.resolve\(ref, scope, referrer\)/],
  ['src/core/engine/rv-bake-survival.ts', /createFileReferenceLookup\(root, options\?\.identity\)/],
  ['src/core/engine/rv-pre-bake.ts', /createFileReferenceLookup\(root, identity\)/],
  ['src/core/engine/rv-pre-bake-hooks.ts', /ctx\.resolveStored\(parentValue\)/],
  ['src/core/engine/rv-reference-audit.ts', /registry\.auditStoredReference\?\.\(/],
  ['src/plugins/drive-order-plugin.ts', /registry\.readStoredRef\(d\.node, raw/],
  ['src/plugins/processindustry-plugin.ts', /registry\.readStoredRef\(owner, path\)/],
  ['src/plugins/connection-system-plugin.ts', /reg\.readStoredRef\(node, path\)/],
  ['private:src/plugins/physics-zone-plugin.ts', /zone\.resolveStaticCollider\(registry, path\)/],
  // plan-661 2D zone: Surface / Guides / KinematicDrives are stored node references.
  ['src/core/engine/rv-physics-zone2d.ts', /registry\.storedNode\(this\.node, ref\)/],
  ['private:src/plugins/physics-zone2d-plugin.ts', /e\.zone\.resolveReference\(registry, path\)/],
];

const CALL = /\.getNode\(|\.getByPath(?:<[^>(]*>)?\(/;

function read(rel: string): string | null {
  const abs = rel.startsWith('private:') ? join(privateRoot, rel.slice('private:'.length)) : join(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function componentModules(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        if (/\bregisterComponent\(\s*\{/.test(text)) out.push(relative(root, p).split(sep).join('/'));
      }
    }
  })(join(root, 'src'));
  return out;
}

/** Engine modules that are not component readers even though they mention `registerComponent({`. */
const NOT_A_COMPONENT = new Set([
  'src/core/engine/rv-component-registry.ts',
  'src/core/engine/rv-scene-loader.ts',
  'src/core/engine/rv-node-registry.ts',
  'src/core/editor/rv-asset-executors.ts',
  'src/core/hmi/hierarchy-utils.ts',
]);

describe('plan-769 9.11 — stored-reference guard (static, F8)', () => {
  it('every getNode / getByPath in a component or stored-reader plugin is classified', () => {
    const files = new Set([
      ...componentModules().filter((f) => !NOT_A_COMPONENT.has(f)),
      'src/plugins/processindustry-plugin.ts', 'src/plugins/connection-gizmo-plugin.ts',
      'src/plugins/aas-link-plugin.tsx', 'src/plugins/drive-order-plugin.ts', 'src/plugins/connection-system-plugin.ts',
      // plan-661: the 2D zone plugin reads the zone's stored node references.
      'private:src/plugins/physics-zone2d-plugin.ts',
    ]);
    const unclassified: string[] = [];
    const stale: string[] = [];
    for (const file of [...files].sort()) {
      const text = read(file);
      if (text === null) continue;
      const allowed = [...(ALLOWLIST[file] ?? [])];
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!CALL.test(line)) return;
        const at = allowed.findIndex(([needle]) => line.includes(needle));
        if (at === -1) unclassified.push(`${file}:${i + 1}: ${line.trim()}`);
        else allowed.splice(at, 1);
      });
      for (const [needle] of allowed) stale.push(`${file}: ${needle}`);
    }
    for (const file of Object.keys(ALLOWLIST)) if (!files.has(file)) stale.push(`${file}: not scanned any more`);
    expect(unclassified, 'classify the new call (or read it through readStoredRef)').toEqual([]);
    expect(stale, 'allowlist entries without a call').toEqual([]);
  });

  it('every Inventory-R stored reader reads through the stored-read API', () => {
    const missing: string[] = [];
    for (const [file, pattern] of STORED_READERS) {
      const text = read(file);
      if (text === null) {
        if (!file.startsWith('private:')) missing.push(`${file}: file missing`);
        continue;
      }
      if (!pattern.test(text)) missing.push(`${file}: ${pattern}`);
    }
    expect(missing).toEqual([]);
  });

  it('the only engine writer of a ComponentReference path is the legacy-only cell-matrix rescope', () => {
    const writers: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
          const text = readFileSync(p, 'utf8');
          text.split(/\r?\n/).forEach((line, i) => {
            if (/\bobj\.path\s*=[^=]/.test(line) || /ComponentReference[^\n]*\.path\s*=[^=]/.test(line)) {
              writers.push(`${relative(root, p).split(sep).join('/')}:${i + 1}`);
            }
          });
        }
      }
    })(join(root, 'src', 'core', 'engine'));
    expect(writers.map((w) => w.replace(/:\d+$/, ''))).toEqual(['src/core/engine/perf/rv-cell-matrix.ts']);
    const cm = read('src/core/engine/perf/rv-cell-matrix.ts')!;
    expect(cm).toMatch(/if \(identity\?\.migrated\) return 0;/);
  });
});
