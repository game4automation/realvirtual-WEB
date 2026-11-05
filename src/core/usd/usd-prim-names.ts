// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Fixed exporter/container names; guarded against the installed USDZExporter. */
export const RESERVED_PRIM_NAMES = ['Geometry', 'Materials', 'Root', 'Scenes', 'Scene', 'MUs'] as const;
export const PLACEHOLDER_PREFIX = '_rvN';
/** Export-only part meshes of a split geometry (`_rvP<i>_<k>`, plan-2246); renamed by the post-pass. */
export const PART_PLACEHOLDER_PREFIX = '_rvP';
/** Base name of a split part prim: `rvPart_<k>` unless a real sibling already has it. */
export const PART_NAME_PREFIX = 'rvPart_';

/**
 * Final names of `count` split parts under one runtime prim (plan-2246 R2 #3):
 * allocated AFTER the runtime names, against the final names of the prim's real
 * children and the exporter's fixed names — nothing is reserved up front, no
 * runtime name ever changes. `rvPart_<k>`, else `rvPart_<k>_2`, `_3`, …
 */
export function allocatePartNames(siblingFinalNames: readonly string[], count: number): string[] {
  const used = new Set<string>([...RESERVED_PRIM_NAMES, ...siblingFinalNames]);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const base = `${PART_NAME_PREFIX}${k}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    out.push(name);
  }
  return out;
}
const TRANSLIT = new Map<number, string>([
  [0xe4, 'ae'], [0xf6, 'oe'], [0xfc, 'ue'],
  [0xc4, 'Ae'], [0xd6, 'Oe'], [0xdc, 'Ue'], [0xdf, 'ss'],
]);

/** USD identifier, using the runtime sanitizer with German transliteration. */
export function sanitizePrimName(raw: string): string {
  let name = raw.replace(/[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/g, (c) => TRANSLIT.get(c.charCodeAt(0))!).replace(/[^A-Za-z0-9_]/g, '');
  if (/^[0-9]/.test(name)) name = '_' + name;
  return name || 'Object';
}

/** One namespace per export parent, allocated in child traversal order. */
export class SiblingNameAllocator {
  private readonly parents = new Map<object, Set<string>>();
  allocate(parent: object, raw: string): string {
    let used = this.parents.get(parent);
    if (!used) { used = new Set<string>(RESERVED_PRIM_NAMES); this.parents.set(parent, used); }
    const base = sanitizePrimName(raw);
    let name = base;
    if (used.has(name)) {
      const reserved = (RESERVED_PRIM_NAMES as readonly string[]).includes(base);
      for (let i = reserved ? 1 : 2; ; i++) {
        name = `${base}_${i}`;
        if (!used.has(name)) break;
      }
    }
    used.add(name);
    return name;
  }
}
