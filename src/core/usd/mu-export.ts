// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { buildRuntimeStageTree, createExportTextureContext, STAGE_SCENE_PATH, type ExportTextureContext, type RuntimeStageInput, type RuntimeStageTree } from './runtime-stage-export';
import { PLACEHOLDER_PREFIX, SiblingNameAllocator } from './usd-prim-names';
import { primIdentityForNode, type PrimAddressRegistry, type PrimIdentity } from './usd-prim-identity';

export interface MuExportEntry {
  muId: number;
  /** Own runtime subtree, or null for an instanced MU. */
  node: Object3D | null;
  template: Object3D | null;
  preplaced: boolean;
}

export interface MuStageTree {
  /** Sampler indices refer only to this model table, excluding every MU. */
  model: RuntimeStageTree;
  clones: Object3D[];
  finalNames: string[];
  primPaths: string[];
  identities: Map<number, PrimIdentity>;
  musRoot: Object3D;
  muPrimIndices: Map<number, number>;
  templateIndices: number[];
  /** Missing geometry is reported, never replaced by guessed geometry. */
  skipped: number[];
  muNodes: Set<Object3D>;
  names: SiblingNameAllocator;
  textureContext: ExportTextureContext;
}

/** Detached snapshots share resources; nobody here disposes shared geometry/material. */
export function buildStageWithMus(input: RuntimeStageInput, mus: readonly MuExportEntry[], registry?: PrimAddressRegistry): MuStageTree {
  const muNodes = new Set(input.exclude);
  for (const mu of mus) if (mu.node) muNodes.add(mu.node);
  for (const mu of input.preplaced) muNodes.add(mu.node);
  const textureContext = createExportTextureContext();
  const model = buildRuntimeStageTree({ ...input, exclude: muNodes, preplaced: [] }, { primNames: 'sibling', textureContext });
  const clones: Object3D[] = [];
  model.scene.traverse((node) => {
    if (node !== model.scene) clones[Number(node.name.slice(PLACEHOLDER_PREFIX.length))] = node;
  });
  const identities = new Map<number, PrimIdentity>();
  if (registry) model.nodes.forEach((node, index) => {
    const identity = primIdentityForNode(node, registry);
    if (identity) identities.set(index, identity);
  });
  const musRoot = new Object3D(); musRoot.name = 'MUs'; model.scene.add(musRoot);
  const stage: MuStageTree = {
    model, clones, finalNames: [...model.finalNames!], primPaths: [...model.primPaths], identities,
    musRoot, muPrimIndices: new Map(), templateIndices: input.templates.flatMap((node) => {
      const index = model.indexOf.get(node); return index === undefined ? [] : [index];
    }), skipped: [], muNodes, names: new SiblingNameAllocator(), textureContext,
  };
  for (const mu of mus) appendMuToStage(stage, mu, registry);
  return stage;
}

/** Snapshot on spawn, before a destroyed MU can disappear. Duplicate ids are idempotent. */
export function appendMuToStage(stage: MuStageTree, mu: MuExportEntry, registry?: PrimAddressRegistry): number | undefined {
  const existing = stage.muPrimIndices.get(mu.muId);
  if (existing !== undefined) return existing;
  const source = mu.node ?? mu.template;
  if (!source) { if (!stage.skipped.includes(mu.muId)) stage.skipped.push(mu.muId); return undefined; }
  if (mu.node) stage.muNodes.add(mu.node);
  const exclude = new Set(stage.muNodes); exclude.delete(source);
  const sub = buildRuntimeStageTree({ root: source, templates: [source], exclude, preplaced: [] }, { primNames: 'sibling', textureContext: stage.textureContext });
  const root = sub.scene.children[0];
  if (!root) { stage.skipped.push(mu.muId); return undefined; }
  const offset = stage.clones.length;
  const finalNames = sub.finalNames!;
  finalNames[0] = stage.names.allocate(stage.musRoot, source.name + '_' + (stage.muPrimIndices.size + 1));
  root.traverse((clone) => {
    const local = Number(clone.name.slice(PLACEHOLDER_PREFIX.length)), index = offset + local;
    clone.name = PLACEHOLDER_PREFIX + index;
    stage.clones[index] = clone;
    stage.finalNames[index] = finalNames[local];
    const localPath = sub.primPaths[local].slice(STAGE_SCENE_PATH.length).split('/').slice(2).join('/');
    stage.primPaths[index] = `${STAGE_SCENE_PATH}/MUs/${finalNames[0]}${localPath ? '/' + localPath : ''}`;
    // Spawned descendants must never acquire identity from clone-carried userData.
    const identity = registry ? primIdentityForNode(sub.nodes[local], registry,
      local === 0 ? { mu: { preplaced: mu.preplaced, template: mu.template } }
        : mu.preplaced ? {} : { mu: { preplaced: false, template: mu.template } }) : undefined;
    if (identity) stage.identities.set(index, identity);
  });
  stage.musRoot.add(root);
  stage.muPrimIndices.set(mu.muId, offset);
  for (const id of sub.vertexColorMaterialIds) stage.model.vertexColorMaterialIds.add(id);
  stage.model.texturesConverted += sub.texturesConverted;
  stage.model.texturesSkipped += sub.texturesSkipped;
  return offset;
}
