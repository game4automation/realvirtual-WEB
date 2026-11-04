// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 F8 (save side, 9.5) — the DYNAMIC guard over a written file: every stored
 * reference position (`visitReferences`: every ComponentReference at any depth, every
 * PATH_FIELDS value; NAME fields and `AssetOverrides` keys are not positions in Phase 3)
 * and its stored form. A file the web wrote holds no path there.
 */
import { expect } from 'vitest';
import { visitReferences } from '../../src/core/engine/rv-node-path-rewrite.mjs';

export type WrittenGltfJson = {
  scene?: number;
  scenes?: Array<{ nodes?: number[]; extras?: { realvirtual?: Record<string, unknown> } }>;
  nodes?: Array<{ name?: string; children?: number[]; extras?: Record<string, unknown> & { realvirtual?: Record<string, unknown> } }>;
};

export interface StoredPosition {
  where: string;
  form: 'path' | 'address' | 'unresolved';
  path: string;
  value: unknown;
}

/** Every stored reference position of a written file. */
export function storedPositionsOf(json: WrittenGltfJson): StoredPosition[] {
  const out: StoredPosition[] = [];
  const walk = (where: string, rv: Record<string, unknown> | undefined): void => {
    visitReferences(rv, (r) => {
      if (r.kind === 'name') return;
      out.push({ where: `${where}:${r.componentKey}.${r.field}`, form: r.form, path: r.path, value: r.value });
    }, { skipComponent: (k) => k === 'AssetOverrides' || /^AssetOverrides_\d+$/.test(k) });
  };
  walk('scene', json.scenes?.[json.scene ?? 0]?.extras?.realvirtual);
  (json.nodes ?? []).forEach((n, i) => walk(`node[${i}]${n.name ?? ''}`, n.extras?.realvirtual));
  return out;
}

/** F8 save side: no position holds a path (an empty value is no reference). */
export function expectNoPathInReferences(json: WrittenGltfJson): void {
  const paths = storedPositionsOf(json).filter((p) => p.form === 'path' && p.path.trim() !== '');
  expect(paths.slice(0, 20).map((p) => `${p.where} = ${p.path}`)).toEqual([]);
}
