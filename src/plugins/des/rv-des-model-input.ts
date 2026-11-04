// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-model-input.ts — collects the strict fingerprint's model input from a
 * live viewer + DES runner (plan-2059 Phase 1).
 *
 * The runner collects its bind fingerprint at run start; capture and restore
 * activation is delivered separately.
 *
 * What is collected (see `rv-des-fingerprint.ts` for why):
 *  - documents: every live bake instance (`BakeRegistry.instances`) — the main
 *    model as occurrence `''`, every placement by the plan-769 address of its
 *    root; the byte hash comes from the content ledger by `BakedAsset.assetId`;
 *  - scene: every node the `NodeRegistry` addresses (each node once), with its
 *    complete authored extras and its local matrix. Rest-pose rule for nodes
 *    the simulation moves: a drive node contributes the drive's HOME pose, the
 *    nodes declared by des.movedNodes contribute their poses at bind. Every other node
 *    contributes its live pose — a planner move changes the hash.
 *  - components: `{id, type}` of every runner instance.
 *
 * View state is not model: camera, selection, parts hidden or isolated in the
 * groups panel, run-time HMI colours live in no extras, bytes or matrix and are
 * not collected.
 */

import { Matrix4, type Object3D, type Quaternion, type Vector3 } from 'three';
import { documentHashOf, type DocumentHashState } from '../../core/engine/rv-model-content-ledger';
import type {
  FingerprintComponent,
  FingerprintDocument,
  FingerprintSceneNode,
} from './rv-des-fingerprint';

import { pathGraphRows, type FingerprintInput } from './rv-des-fingerprint';
import { getDefaultPathNetwork } from '../../core/engine/rv-path-network';
import { RV_VERSION } from '../../core/rv-version';
import { DES_MANAGER_COMPONENT, isDesRunConfigField } from '../../core/material-flow/des-manager-settings';

/** Structural viewer surface the collector reads. */
export interface ModelInputHost {
  readonly mainDocumentKey?: string | null;
  /** Address source override for headless/test hosts without a NodeRegistry (plan-2059 D7). */
  readonly desAddresses?: {
    forEachNode(cb: (path: string, node: Object3D) => void): void;
    getAddressForNode(node: Object3D): string | null;
  } | null;
  readonly registry: {
    forEachNode(cb: (path: string, node: Object3D) => void): void;
    getAddressForNode(node: Object3D): string | null;
  } | null;
  readonly bakeRegistry?: {
    readonly instances: ReadonlySet<{ readonly root: Object3D; readonly baked: { readonly assetId: string } }>;
  } | null;
  readonly drives?: ReadonlyArray<{
    readonly node: Object3D;
    getHomeLocalPosition?(): Vector3;
    getHomeLocalQuaternion?(): Quaternion;
  }>;
}

/** Structural runner surface the collector reads. */
export interface ModelInputRunner {
  readonly liveInstances: ReadonlyArray<{
    readonly def: { readonly type: string };
    readonly adapter: { readonly node: Object3D };
    readonly desId: string | null;
    readonly bindPoses: ReadonlyMap<Object3D, readonly number[]>;
  }>;
}

/** The model part of a {@link import('./rv-des-fingerprint').FingerprintInput}. */
export interface CollectedModelInput {
  readonly documents: FingerprintDocument[];
  readonly scene: FingerprintSceneNode[];
  readonly components: FingerprintComponent[];
}

const _m = new Matrix4();

/**
 * The address of the nearest addressed ancestor (`''` = none): the authored
 * hierarchy. An editor reparent between parents with equal world transforms
 * changes no address, extras or local pose of the moved node, but this
 * (review finding 1). The simulation never reparents ADDRESSED nodes — MUs and
 * carried loads are runtime clones without an address; kinematic re-parenting
 * happens once in the bake's prepare, before any bind.
 */
function addressedParentOf(node: Object3D, registry: NonNullable<ModelInputHost['registry']>): string {
  for (let p = node.parent; p; p = p.parent) {
    const a = registry.getAddressForNode(p);
    if (a) return a;
  }
  return '';
}

function livePose(node: Object3D): number[] {
  return _m.compose(node.position, node.quaternion, node.scale).toArray();
}

/**
 * Collect documents, scene and components.
 *
 * @param host the viewer (or a test double).
 * @param runner the DES runner whose instances are bound.
 * @param opts.mainDocumentKey the main model's `BakedAsset.assetId` (its load
 *   URL); the instance carrying it is occurrence `''`.
 * @param opts.hashOf ledger lookup (default: the page's content ledger).
 */
export function collectModelInput(
  host: ModelInputHost,
  runner: ModelInputRunner,
  opts: {
    mainDocumentKey: string | null;
    hashOf?: (key: string) => DocumentHashState;
    /** Scene rows collected earlier (the runner's rows at bind, plan-2059 C5) — reused as is. */
    scene?: readonly FingerprintSceneNode[];
  },
): CollectedModelInput {
  const hashOf = opts.hashOf ?? documentHashOf;
  const registry = host.desAddresses ?? host.registry;

  const documents: FingerprintDocument[] = [];
  let mainSeen = false;
  for (const inst of host.bakeRegistry?.instances ?? []) {
    const key = inst.baked.assetId;
    let occurrence: string | null;
    if (opts.mainDocumentKey !== null && key === opts.mainDocumentKey && !mainSeen) {
      occurrence = '';
      mainSeen = true;
    } else {
      // An unaddressed placement root is reported by the builder as a
      // document without occurrence — never silently dropped.
      occurrence = registry?.getAddressForNode(inst.root) ?? null;
    }
    documents.push({ occurrence, key, hash: hashOf(key) });
  }
  // A main model that drew nothing has no bake instance — its bytes are still the model.
  if (!mainSeen && opts.mainDocumentKey) {
    documents.push({ occurrence: '', key: opts.mainDocumentKey, hash: hashOf(opts.mainDocumentKey) });
  }

  // Rest poses: drive home pose and exactly the declared moved nodes at bind.
  const restPose = new Map<Object3D, number[]>();
  for (const d of host.drives ?? []) {
    if (!d?.node || typeof d.getHomeLocalPosition !== 'function' || typeof d.getHomeLocalQuaternion !== 'function') continue;
    restPose.set(d.node, new Matrix4().compose(d.getHomeLocalPosition(), d.getHomeLocalQuaternion(), d.node.scale).toArray());
  }
  const components: FingerprintComponent[] = [];
  for (const inst of runner.liveInstances) {
    components.push({ id: inst.desId, type: inst.def.type });
    for (const [node, pose] of inst.bindPoses) restPose.set(node, [...pose]);
  }

  const scene: FingerprintSceneNode[] = opts.scene ? [...opts.scene] : [];
  if (registry && !opts.scene) {
    const seen = new Set<Object3D>();
    registry.forEachNode((_path, node) => {
      if (seen.has(node)) return; // alias paths name the same node
      seen.add(node);
      const address = registry.getAddressForNode(node);
      if (!address) return; // not file content (synthetic partition, runtime clone)
      const extras = withoutRunConfig((node.userData as Record<string, unknown> | undefined)?.realvirtual ?? null);
      scene.push({ address, parent: addressedParentOf(node, registry), extras, matrix: restPose.get(node) ?? livePose(node) });
    });
  }
  return { documents, scene, components };
}

/** DESManager run parameters are run configuration, not model (plan-2059, Thomas 2026-11-01). */
function withoutRunConfig(extras: unknown): unknown {
  if (extras === null || typeof extras !== 'object') return extras;
  const manager = (extras as Record<string, unknown>)[DES_MANAGER_COMPONENT];
  if (manager === null || typeof manager !== 'object') return extras;
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(manager as Record<string, unknown>)) {
    if (!isDesRunConfigField(DES_MANAGER_COMPONENT, field)) kept[field] = value;
  }
  return { ...(extras as Record<string, unknown>), [DES_MANAGER_COMPONENT]: kept };
}

/** Full input, including bound script text and effective run parameters. */
export function collectFingerprintInput(
  host: ModelInputHost,
  runner: ModelInputRunner & {
    readonly rngVersion: number;
    fingerprintRunConfig(): unknown;
    fingerprintScripts(): ReadonlyArray<{ id: string; source: string }>;
  },
  opts: { mainDocumentKey: string | null; hashOf?: (key: string) => DocumentHashState; scene?: readonly FingerprintSceneNode[] },
): FingerprintInput {
  return { ...collectModelInput(host, runner, opts),
    scripts: runner.fingerprintScripts(), runConfig: runner.fingerprintRunConfig(),
    pathGraph: pathGraphRows(getDefaultPathNetwork()), rngVersion: runner.rngVersion,
    runtimeVersion: RV_VERSION.version };
}
