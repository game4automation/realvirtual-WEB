// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-prepare-and-bake.ts — THE recipe (plan-757 D1, F1): steps 2–4 of the
 * unified pipeline, as ONE function of the GLB tree and the capability table.
 *
 *   load → **prepare → bake → drop** → place → init
 *
 * `loadGLB` (the main model) and `ModelCache._bake` (every planner placement)
 * both call this and nothing else. Before plan-757 the loader ran the pre-bake
 * hooks, the survival model and the material phases inline and the cache ran
 * a reduced copy — the same Arburg opened as a document cycled, placed ten
 * times its drives carried no geometry and nothing moved.
 *
 * What the recipe does, in order (§2.4):
 *
 *  1. naming-convention scan (`Drive-*` / `Transport-*` / `Sensor*` → extras);
 *  2. `prepare`: the pre-bake registry over `tmp`, every `onPreBake` hook, the
 *     re-parented paths re-registered, the drive HOME stamps re-taken for
 *     every node a hook MOVED (a moved node's home is its local TRS under the
 *     FINAL parent — the fixture-(b) defect of Phase 0);
 *  3. survival (`ctx.claims` — plugin claims are a main-model input, D5) and
 *     the removal report (G1). THE role pass of the bake runs in here, ONCE
 *     (plan-582 §2.4) — `survival.roles` is handed to step 5 as
 *     `BakeOptions.roles`, so the bake buckets items and never classifies a
 *     second time;
 *  4. materials: `dedup → uber`, once per tree ({@link prepareMaterials});
 *  5. `bake({ destructive: true })`, re-pointing the renamed-node map onto the
 *     template in `onTemplateBuilt`;
 *  6. the ASSET-RELATIVE path aliases (renamed nodes + re-parented previous
 *     paths) and the signature state go onto the {@link BakedAsset} (D4, D8).
 *
 * Rejects with {@link BakeAbortedError} when `ctx.isEpochCurrent()` turns
 * false while the bake runs — an abort, never a load error (F10).
 *
 * Import boundary (`tests/engine-import-boundary.node.test.ts`): this module
 * imports nothing from `src/core/rv-viewer.ts`, `src/plugins/` or
 * `src/core/hmi/`. Everything it needs is engine data.
 */

import { applyAuthoredInactive } from './rv-authored-inactive';
import { Object3D } from 'three';
import { NodeRegistry } from './rv-node-registry';
import {
  buildPreBakeRegistry, collectMaterialsByName, createPreBakeContext, registerMaterialIndex,
  registerReparentedPaths, runPreBakeHooks,
  type PreBakeReparent,
} from './rv-pre-bake';
import { registerBuiltInPreBakeHooks } from './rv-pre-bake-hooks';
import { recordBakeRemovalReport, type BakeClaim } from './rv-bake-survival';
import { deduplicateMaterials, type DedupResult } from './rv-material-dedup';
import { applyUberMaterial, type RVUberMaterial, type UberResult } from './rv-uber-material';
import { bake } from './rv-bake-pipeline';
import type { BakedAlias, BakedAsset } from './rv-bake-chunk';
import type { PickBuildPort } from './rv-pick-build-port';
import type { SignatureState } from '../persistence/rv-sig-verify';
import { forEachNodeAlias } from './rv-node-aliases';
import { applyNamingScan } from './rv-naming-scan';
import { relativeToRoot } from './rv-reference-resolver';
import { RV_DRIVE_HOME_KEY, type DriveHomePose } from './rv-pre-bake-keys';
import { debug } from './rv-debug';
import { stripPersistedSensorViz } from './rv-sensor-viz-names';
import { getDecodeIdentity, type FileIdentity } from './rv-decode-identity';

export { stripPersistedSensorViz };

/** Everything the recipe needs beyond the tree — per-source data, never viewer state. */
export interface PrepareAndBakeContext {
  /** Cache key / url of the asset (`BakedAsset.assetId`). */
  assetId: string;
  /** The URL the bytes were read from — `BakedAsset.url`, the base of the asset's own relative references (F3). */
  url?: string;
  /**
   * glTF name-dedup map of THIS parse (`detectRenamedNodes`). Re-pointed IN
   * PLACE onto the template nodes when the bake drops `tmp`, so a caller that
   * keeps the map (the loader hands it to `initSubtree` for the SignalStore
   * aliases) never holds a dropped node.
   */
  renamedNodes: Map<Object3D, string>;
  /** Signature verdict of the bytes — becomes `BakedAsset.signatureState` (D8). */
  signatureState: SignatureState;
  /**
   * The session's shared uber material. `null` SKIPS the uber pass (every
   * material stays its own chunk bucket) — the parity rule plan-752 S4 for a
   * session whose main model did not bake onto the uber material either.
   */
  uber: RVUberMaterial | null;
  isWebGPU: boolean;
  /** Pick-structure build port (test seam: inline port). Default: the shared pool. */
  pickPort?: PickBuildPort;
  /** Decode epoch recorded on the asset. Default 0. */
  epoch?: number;
  /** Re-checked after every `await`; `false` aborts with {@link BakeAbortedError}. */
  isEpochCurrent?: () => boolean;
  /** Forced chunk split (deferred placement roots; `trsByNodeId` is gone, plan-769 F14). */
  forceSplit?: (node: Object3D) => boolean;
  /**
   * Plugin bake claims (plan-754 D17) — main model only (D5). `complete: false`
   * says the plugins could not be asked (deferred model plugins), which the
   * removal report records as "not checked" instead of a clean zero.
   */
  claims?: { list: ReadonlyArray<BakeClaim>; complete: boolean };
  /** The caller's own window to re-point `tmp`-keyed bookkeeping (see `BakeOptions.onTemplateBuilt`). */
  onTemplateBuilt?: (nodeOf: ReadonlyMap<Object3D, Object3D>) => void;
  /**
   * Default `true`. `false` keeps `tmp` as the template (a tree that draws
   * nothing has no chunk to bake and nothing to drop — the `ModelCache` gate
   * for an empty or reference-only asset). The hooks, survival report,
   * materials and aliases run identically in both cases.
   */
  destructive?: boolean;
  /**
   * plan-769 Phase 1b: the decoded file's identity record. `prepare` (the Kinematic
   * hook) and the survival model read every STORED reference by its verdict — the
   * same one the registry reads after the bake ("Survival == Runtime"). Omitted =
   * the record linked to `tmp` at decode (`getDecodeIdentity`); `null` = none.
   */
  identity?: FileIdentity | null;
}

// ─── Materials: dedup → uber, once per tree ──────────────────────────

/** What the material phase produced for a tree (the loader's DevTools stats). */
export interface PreparedMaterials {
  dedup: DedupResult;
  uber: UberResult;
}

/**
 * Done-marker of the material phase (D6): keyed by the tree root it ran on
 * and, after the bake, by the template that replaced it. A `WeakMap`, never
 * `userData` — it holds live material sets, and `userData` is JSON-cloned.
 */
const _materialsDone = new WeakMap<Object3D, PreparedMaterials>();

const EMPTY_UBER: UberResult = Object.freeze({
  eligibleMaterialCount: 0, bakedMeshCount: 0, sharedMaterial: null,
  sharedGeometryReuses: 0, clonedGeometryCount: 0, disposedSourceGeometries: 0,
});

/**
 * The ONE material phase of the recipe: `deduplicateMaterials` (identical
 * material instances collapse) then `applyUberMaterial` (every untextured
 * standard material collapses onto the shared uber singleton). IDEMPOTENT per
 * tree: a second call on the same root returns the first result and touches
 * nothing — so a caller that already prepared a tree and the recipe that runs
 * on it later cannot disagree, and the bake buckets by exactly one material
 * state (measured in Phase 0: the step is behaviour-neutral on untextured
 * corpora and changes chunk counts only with textured materials).
 *
 * `uber === null` skips the uber pass (plan-752 S4).
 */
export function prepareMaterials(root: Object3D, uber: RVUberMaterial | null, isWebGPU: boolean): PreparedMaterials {
  const done = _materialsDone.get(root);
  if (done) return done;
  const dedup = deduplicateMaterials(root);
  const uberResult = uber === null
    ? { ...EMPTY_UBER }
    : applyUberMaterial(root, dedup.uniqueMaterials, isWebGPU, uber);
  // Keep the reported count in step with the post-uber state (DevTools panel).
  dedup.uniqueCount = dedup.uniqueMaterials.size;
  const result: PreparedMaterials = { dedup, uber: uberResult };
  _materialsDone.set(root, result);
  return result;
}

/** The material results of a tree {@link prepareMaterials} ran on — also answered for a bake's template. */
export function preparedMaterialsOf(root: Object3D): PreparedMaterials | undefined {
  return _materialsDone.get(root);
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * The authored hidden flag (`rv.Hidden`, the editor's eye toggle) becomes
 * `.visible = false` BEFORE survival and the bake. The init re-applies it too
 * (`rv-scene-loader.ts`), but that runs on the baked template — too late for a
 * bare CAD part: nothing claims it, so the bake merged its geometry into the
 * parent's chunk and the part was drawn again in every runtime load (a test
 * run of the asset editor, a placement, a delivery). An invisible mesh is
 * classified `keep` by the bake, survives as its own node and stays hidden.
 * The root's own visibility is the instance's concern and is left alone.
 * The same holds for a node authored inactive (`activeSelf: false`, plan-2016 S5).
 * Returns the number of nodes hidden.
 */
export function applyAuthoredHidden(root: Object3D): number {
  let hidden = 0;
  root.traverse((node) => {
    if (node === root) return;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv?.['Hidden'] === true && node.visible) {
      node.visible = false;
      hidden++;
    }
    // plan-2016 S5: a node authored inactive (Unity `activeSelf: false`) loads
    // hidden too, flagged so a spawned MU clone keeps it hidden.
    const wasVisible = node.visible;
    if (applyAuthoredInactive(node) && wasVisible) hidden++;
  });
  return hidden;
}

/**
 * A node a hook MOVED has a new local TRS (`attach()` preserves the world
 * pose). The `Drive` hook stamped the home pose BEFORE the kinematic hook ran
 * (`PRE_BAKE_TYPE_ORDER`), so on such a node the stamp is the authored local
 * TRS under the OLD parent — and `initDrive()` would put the axis there under
 * the NEW parent (Phase 0, fixture (b): world (0, 0.6, 0) instead of
 * (1, 0.6, 0)). The rule is the same one the placement pivot follows (§2.4,
 * R11): a shift of the node shifts its stamp. Only the moved node itself is
 * re-stamped — its descendants kept their local TRS.
 */
function restampMovedDriveHomes(reparented: ReadonlyArray<PreBakeReparent>): number {
  let restamped = 0;
  for (const { node } of reparented) {
    const home = node.userData?.[RV_DRIVE_HOME_KEY] as DriveHomePose | undefined;
    if (!home || !Array.isArray(home.p)) continue;
    node.userData[RV_DRIVE_HOME_KEY] = {
      p: [node.position.x, node.position.y, node.position.z],
      q: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      s: [node.scale.x, node.scale.y, node.scale.z],
    } satisfies DriveHomePose;
    restamped++;
  }
  return restamped;
}

/**
 * Every alias path of the template, ASSET-RELATIVE (root = ''): the renamed
 * nodes' historical spellings (both the raw glTF name and its sanitized form,
 * exactly what `registerNodeAliases` publishes) and the AUTHORED path of every
 * subtree a hook re-parented. The place step prefixes them with the instance
 * root's registry path — `Arburg/…` for the main model, `Layout/Arburg_1/…`
 * for a placement — so a reference serialized against the authoring hierarchy
 * resolves on both.
 */
function collectAliases(
  template: Object3D,
  renamedNodes: ReadonlyMap<Object3D, string>,
  reparented: ReadonlyArray<{ node: Object3D; path: string }>,
): BakedAlias[] {
  const out: BakedAlias[] = [];
  const templatePath = NodeRegistry.computeNodePath(template);
  forEachNodeAlias(renamedNodes, (node, _currentPath, aliasPaths) => {
    for (const p of aliasPaths) {
      const rel = relativeToRoot(p, templatePath);
      if (rel !== '') out.push({ path: rel, template: node });
    }
  });
  // A re-parented node's authored path is a PREFIX alias too (plan-610 Phase
  // 5c): one entry covers the whole moved subtree, resolved exactly under the
  // node's new place at lookup time — no per-descendant enumeration.
  for (const { node, path } of reparented) {
    if (path !== '') out.push({ path, template: node, subtree: true });
  }
  return out;
}

// ─── The recipe ──────────────────────────────────────────────────────

/**
 * Prepare `tmp` and bake it into a {@link BakedAsset} — see the file header.
 * `tmp` is CONSUMED on a destructive bake: its keep meshes moved into the
 * template, everything else dropped. The returned asset's `template` is the
 * only graph left.
 */
export async function prepareAndBake(tmp: Object3D, ctx: PrepareAndBakeContext): Promise<BakedAsset> {
  registerBuiltInPreBakeHooks();
  const renamedNodes = ctx.renamedNodes;
  // ONE reader of every authored path during `prepare`, whoever calls
  // (plan-757 F7, `rv-reference-resolver.ts`): a hook path, a reference field
  // and a plugin claim are read RELATIVE TO `tmp` — as written, then with the
  // root's own name stripped (the form Unity exports) — so the loader's staged
  // `tmp` (`Machine/Mount`) and the cache's parentless one (`Mount`) resolve the
  // same references, and both resolve exactly what the runtime registry will
  // resolve after the bake. No staging holder is needed for that any more.
  const rootPath = NodeRegistry.computeNodePath(tmp);
  const rootNames = [tmp.name, renamedNodes.get(tmp)];

  // ── 1. names → extras (idempotent; the loader may have scanned already).
  stripPersistedSensorViz(tmp); // before the scan - see the function
  applyNamingScan(tmp);
  applyAuthoredHidden(tmp);

  // The document material index (plan-496), taken before ANYTHING touches the
  // tree: the dedup and uber passes of step 4 replace materials and rename the
  // survivor, and the `_MaterialDonor` hook of step 2 deletes the very node a
  // band material arrived on — after this line both are harmless, because the
  // table holds the original materials under their original names. It is what
  // `MaterialName` on a ribbon component resolves against.
  const materialsByName = collectMaterialsByName(tmp);

  // ── 2. prepare: hooks on the raw tree, driven by extras alone.
  const prepareRegistry = buildPreBakeRegistry(tmp, renamedNodes);
  const identity = ctx.identity !== undefined ? ctx.identity : getDecodeIdentity(tmp);
  const session = createPreBakeContext(tmp, prepareRegistry, rootNames, identity);
  const preBake = runPreBakeHooks(tmp, session);
  // A moved subtree gets its NEW path registered while the AUTHORED one stays
  // resolvable — the survival model must resolve what the runtime resolves.
  registerReparentedPaths(prepareRegistry, preBake.reparented);
  const restamped = restampMovedDriveHomes(preBake.reparented);
  debug('loader', `[PreBake] ${preBake.hooks} hook(s) ran [${preBake.types.join(', ')}], `
    + `${preBake.reparented.length} subtree(s) re-parented, ${restamped} drive home(s) re-stamped`);
  // The authored paths, asset-relative, for the alias table (step 6).
  let reparented: Array<{ node: Object3D; path: string }> = preBake.reparented.map((r) => ({
    node: r.node, path: relativeToRoot(r.previousPath, rootPath),
  }));

  // ── 3. survival + removal report (G1). Claims: main model only (D5).
  const survival = recordBakeRemovalReport(
    ctx.assetId, tmp, prepareRegistry, ctx.claims?.list,
    (node) => NodeRegistry.computeNodePath(node),
    { forceSplit: ctx.forceSplit, claimsComplete: ctx.claims?.complete ?? true, scope: session.scope, identity },
  );

  // ── 4. materials — the bake buckets by material, so both passes precede it.
  const materials = prepareMaterials(tmp, ctx.uber, ctx.isWebGPU);

  // ── 5. bake + drop.
  const asset = await bake(tmp, {
    assetId: ctx.assetId,
    url: ctx.url,
    epoch: ctx.epoch,
    isEpochCurrent: ctx.isEpochCurrent,
    // The bucket material: what the uber pass collapsed onto — or the session
    // material itself when nothing was left to collapse (a master whose meshes
    // already carry the uber material, e.g. a re-bake). `null` only when the
    // uber pass was skipped (S4): every material is then its own bucket.
    uberMaterial: materials.uber.sharedMaterial ?? ctx.uber,
    pickPort: ctx.pickPort,
    forceSplit: ctx.forceSplit,
    incomingRoles: survival.incoming,
    // plan-582 §2.4: ONE role pass per bake. Step 3 classified the tree for
    // the survival model — BEFORE the material phase — and the bake takes that
    // result instead of running its own DFS. The handoff is sound because all
    // three consumed quantities are invariant under `dedup → uber` (§6c M4/M5);
    // what the material phase decides (buckets, chunk keys) is computed inside
    // the bake, after step 4, and nowhere else.
    roles: survival.roles,
    destructive: ctx.destructive ?? true,
    survives: survival.survives,
    signatureState: ctx.signatureState,
    onTemplateBuilt: (nodeOf) => {
      // The renamed-node map is keyed by `tmp` nodes — re-point it before the
      // map is released, or no alias would name a node that exists.
      const remapped = new Map<Object3D, string>();
      for (const [node, original] of renamedNodes) {
        const template = nodeOf.get(node);
        if (template) remapped.set(template, original);
      }
      renamedNodes.clear();
      for (const [node, original] of remapped) renamedNodes.set(node, original);
      // Same for the re-parented subtrees: the alias names the TEMPLATE node.
      const moved: Array<{ node: Object3D; path: string }> = [];
      for (const r of reparented) {
        const template = nodeOf.get(r.node);
        if (template) moved.push({ node: template, path: r.path });
      }
      reparented = moved;
      ctx.onTemplateBuilt?.(nodeOf);
    },
  });

  // ── 6. what travels with the asset: aliases (D4) and the material results.
  asset.aliases = collectAliases(asset.template, renamedNodes, reparented);
  asset.materialsByName = materialsByName;
  registerMaterialIndex(asset.template, materialsByName);
  _materialsDone.set(asset.template, materials);
  return asset;
}
