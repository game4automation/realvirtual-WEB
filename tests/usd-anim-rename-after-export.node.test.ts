// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Object3D } from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { buildRuntimeStageTree } from '../src/core/usd/runtime-stage-export';
import { postProcessModelUsda } from '../src/core/usd/usd-stage-post';
import { primIdentityForNode } from '../src/core/usd/usd-prim-identity';

async function snapshots(): Promise<[string, string]> {
  const root = new Object3D(), child = new Object3D(), parent = new Object3D();
  root.name = 'Cell'; child.name = 'Before'; parent.name = 'Other';
  setNodeId(root, 'cell'); setNodeId(child, 'stable-id'); setNodeId(parent, 'parent');
  root.add(child, parent);
  const reg = new NodeRegistry(); reg.registerDocument(root);
  const output = async () => {
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set(), preplaced: [] }, { primNames: 'sibling' });
    const bytes = await new USDZExporter().parseAsync(tree.scene, { includeAnchoringProperties: false });
    const text = strFromU8(unzipSync(new Uint8Array(bytes))['model.usda']);
    return postProcessModelUsda(text, { finalNames: tree.finalNames!, prims: new Map(tree.nodes.map((n, i) => [i, { customData: primIdentityForNode(n, reg) }])) }).text;
  };
  const before = await output(); child.name = 'After'; parent.add(child);
  const after = await output();
  return [before, after];
}
describe('export snapshot survives rename and reparent', () => {
  it('old bytes retain old name; new bytes contain new name and the same registry address', async () => {
    const [before, after] = await snapshots();
    expect(before).toContain('def Xform "Before"'); expect(before).not.toContain('def Xform "After"');
    expect(after).toContain('def Xform "After"'); expect(after).not.toContain('def Xform "Before"');
    for (const text of [before, after]) expect(text).toContain('string address = "#stable-id"');
  });
  it.skipIf(!process.env.RV_USD_PYTHON)('usd-core opens and flattens both snapshots', async () => {
    const script = 'import sys\nfrom pxr import Sdf, Usd\nl = Sdf.Layer.CreateAnonymous()\nassert l.ImportFromString(sys.stdin.read())\ns = Usd.Stage.Open(l)\nassert s and s.Flatten()\n';
    for (const text of await snapshots()) {
      const result = spawnSync(process.env.RV_USD_PYTHON!, ['-c', script], { input: text, encoding: 'utf8', windowsHide: true });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      // Existing three r185 metadata warning, already documented by the phase-0 spike.
      // Keep it visible; unrelated warnings/errors still fail this check.
      if (result.stderr) console.warn(result.stderr.trim());
      expect(result.stderr.replace(/^Warning: in _CopyMetadata[^\r\n]*unknown field 'sceneName'\r?\n?/gm, '').trim()).toBe('');
    }
  });
});
