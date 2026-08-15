// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-compose — Phase 1.5 of the load path: turn the root file plus every
 * file it references into ONE tree, before any tree phase runs.
 *
 * ## Why it has to sit here and nowhere else
 *
 * `loadGLB` runs four passes over `root` before it ever registers a node:
 * `processMeshes` (shadow classification, triangle counts, the drive/transport
 * node sets), `detectRenamedNodes` plus the glTF index capture, the
 * `<glb>.kin.json` sidecar, and the library naming-convention scan. A subtree
 * grafted in later than that silently skips all four — its meshes never cast
 * shadows, its drives never enter `driveNodeSet`, and the write path has no
 * index for any of its nodes. Composition therefore runs immediately after the
 * parse, and from that point on the loader sees exactly one tree and needs no
 * knowledge that references ever existed.
 *
 * ## Bytes are cached, subtrees are cloned
 *
 * An `Object3D` has exactly one parent in Three.js, so a cached subtree can
 * never be grafted twice. The cache therefore holds a parse TEMPLATE that is
 * never added to the scene, and every occurrence gets `template.clone()` — the
 * same contract `ModelCache.getOrLoad` already lives by. Clones share their
 * `BufferGeometry` and materials with the template, which is both the memory
 * win and the reason the Phase-0 export gate passes: `GLTFExporter` dedups
 * shared geometry.
 *
 * Because clones share the template's GPU resources, **the template owns them**.
 * A cache is created per load unless the caller passes one, so those resources
 * die with the load and no later load can inherit geometry an intervening
 * uber-material bake may have mutated. Cross-load caching is a deliberate
 * follow-up, not an oversight.
 *
 * ## Identity, cycles and depth
 *
 * `visited` is PATH-scoped, not global: the same assembly may legitimately
 * appear ten times in one plant — that is a DAG, not a cycle. Only a recurrence
 * on the same resolution path is a cycle. Relative paths resolve against the
 * file the reference is WRITTEN IN, never against the root scene.
 *
 * ## Trust does not flow downhill
 *
 * Each frame carries the signature state of its own file, and its EFFECTIVE
 * state is the weakest along its resolution path. See {@link isFrameGated} for
 * the rule that keeps a signed root from lending its trust to unsigned content.
 */

import type { Object3D } from 'three';
import type { SignatureState } from '../persistence/rv-sig-verify';
import {
  type AssetReference,
  type OrphanedOverride,
  MAX_REFERENCE_DEPTH,
  applyAssetOverrides,
  collectReferenceNodes,
  getAssetOverrides,
  makeSubtreeResolvers,
} from './rv-asset-reference';
import {
  buildMissingReferencePlaceholder,
  missingReferenceLabel,
} from './rv-missing-reference-placeholder';
import {
  ROOT_OCCURRENCE,
  ROOT_SOURCE_KEY,
  childOccurrence,
  deriveNodeIdsForSubtree,
  getNodeId,
} from './rv-node-id';
import { parseGlbSubtreeWithMeta } from './rv-glb-parse';
import { debug } from './rv-debug';

// ─── Errors ──────────────────────────────────────────────────────────────

/**
 * A reference chain returned to a file already open on the same path.
 *
 * Thrown, not tolerated: a cycle has no correct resolution, and the alternative
 * — stopping quietly at the repeat — would produce a tree whose shape depends on
 * traversal order.
 */
export class ReferenceCycleError extends Error {
  constructor(public readonly trail: string[]) {
    super(`Referenzzyklus (reference cycle): ${trail.join(' → ')}`);
    this.name = 'ReferenceCycleError';
  }
}

/** The reference chain went deeper than {@link MAX_REFERENCE_DEPTH}. */
export class ReferenceDepthError extends Error {
  constructor(public readonly depth: number, public readonly trail: string[]) {
    super(
      `Referenztiefe überschritten (reference depth exceeded, max ${MAX_REFERENCE_DEPTH}): `
      + trail.join(' → '),
    );
    this.name = 'ReferenceDepthError';
  }
}

/** Composition was abandoned because {@link ComposeOptions.shouldAbort} said so. */
export class ComposeAbortedError extends Error {
  constructor() {
    super('Composition aborted (superseded load)');
    this.name = 'ComposeAbortedError';
  }
}

// ─── Path resolution (F18) ───────────────────────────────────────────────

/** Collapse `.` and `..` segments in an already-joined relative path. */
function normalizeSegments(path: string): string {
  const leadingSlash = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!leadingSlash) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return (leadingSlash ? '/' : '') + out.join('/');
}

function hasScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Resolve a reference's `path` against the file the reference lives in (F18).
 *
 * `anlage.glb` → `unterordner/baugruppe.glb` → `./teil.glb` must land on
 * `unterordner/teil.glb`, not on `teil.glb`: a library assembly cannot know
 * where the plant that uses it was opened from, so its own relative paths can
 * only ever mean "next to me".
 *
 * A relative base stays relative. Rewriting it through `new URL` would bind the
 * result to the document origin, and the result is also a cache key — an origin
 * baked into it would split the cache per page.
 */
export function resolveReferencePath(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  if (hasScheme(path)) return path;
  if (hasScheme(baseUrl)) {
    // An OPAQUE base — the blob:/data: object URLs library providers hand out —
    // has no path hierarchy, and `new URL('./x.glb', 'blob:…')` THROWS a
    // TypeError that would kill the whole composition. A relative path cannot
    // mean anything under such a base, so it is passed through normalized: the
    // resolver's assetId/library step is the real lookup there, and a path that
    // stays unresolved becomes a labelled placeholder instead of a crash.
    if (/^(blob|data):/i.test(baseUrl)) return normalizeSegments(path);
    return new URL(path, baseUrl).href;
  }
  if (path.startsWith('/')) return normalizeSegments(path);
  const cut = baseUrl.lastIndexOf('/');
  const baseDir = cut >= 0 ? baseUrl.slice(0, cut + 1) : '';
  return normalizeSegments(baseDir + path);
}

// ─── Signature strength (§2.9) ───────────────────────────────────────────

const SIGNATURE_RANK: Record<SignatureState, number> = {
  invalid: 0,
  unverifiable: 1,
  none: 2,
  valid: 3,
};

/** The weaker of two signature states — trust is never gained by nesting. */
export function weakestSignatureState(a: SignatureState, b: SignatureState): SignatureState {
  return SIGNATURE_RANK[a] <= SIGNATURE_RANK[b] ? a : b;
}

/**
 * Whether a frame's components must NOT be initialized.
 *
 * Two independent reasons, and both are needed:
 *
 *  1. **The state is broken** (`invalid` / `unverifiable`). This is the rule the
 *     loader already applied to the whole model, unchanged.
 *  2. **The root is signed and this frame is not.** Without it a reference would
 *     be a privilege escalation: an attacker who can drop an unsigned file next
 *     to a signed scene would get their logic executed under the signed scene's
 *     trust. An unsigned root keeps behaving exactly as before — nothing claimed
 *     trust there in the first place.
 *
 * `allowUntrustedLogic` is the user's explicit release and overrides both, as it
 * does today.
 */
export function isFrameGated(
  effectiveState: SignatureState,
  rootState: SignatureState,
  allowUntrustedLogic: boolean,
): boolean {
  if (allowUntrustedLogic) return false;
  if (effectiveState === 'invalid' || effectiveState === 'unverifiable') return true;
  return rootState === 'valid' && effectiveState !== 'valid';
}

// ─── Resolver contract ───────────────────────────────────────────────────

/** What the resolver is told about the file the reference is written in. */
export interface ResolveContext {
  /** URL of the CONTAINING file — the base for `ref.path` (F18). */
  baseUrl: string;
  /** Occurrence address of the reference node. */
  occurrence: string;
  /** How deep the containing file sits; 0 for the root scene. */
  depth: number;
  /** `ref.path` already resolved against `baseUrl`, for a plain fetch. */
  resolvedPath: string;
}

/** Bytes plus everything only the fetching side can know about them. */
export interface ResolvedReference {
  bytes: ArrayBuffer;
  /** The URL the bytes actually came from; the base for the file's OWN references. */
  url: string;
  /** Content hash. Derived NodeIds hang on it, so it is not optional in practice. */
  sha256?: string;
  signatureState?: SignatureState;
  signaturePresent?: boolean;
}

/**
 * How a reference becomes bytes.
 *
 * Injected rather than hard-wired: the resolution order (asset id first, path
 * second) belongs to the library registry, and tests must be able to compose a
 * whole plant without a network.
 *
 * Returning `null` means "not found" — the reference node is left empty and the
 * miss is reported. Throwing means the load fails.
 */
export type ReferenceResolver = (
  ref: AssetReference,
  context: ResolveContext,
) => Promise<ResolvedReference | null>;

// ─── Template cache ──────────────────────────────────────────────────────

/** A parsed, never-scene-attached subtree plus its source metadata. */
export interface GlbTemplate {
  root: Object3D;
  url: string;
  sha256: string;
  /** Byte length of the source file. The honest basis for a flat-export preview. */
  sizeBytes: number;
  sourceKey: string;
  signatureState: SignatureState;
  signaturePresent: boolean;
  gltfNodeIndices: Map<Object3D, number>;
  gltfNodeNames: readonly (string | undefined)[];
}

/**
 * Resolve-and-parse once per asset, clone per occurrence.
 *
 * The in-flight map is what makes "ten references, one fetch" true even when the
 * ten resolutions start concurrently — the same `_shared()` dedup the planner's
 * `ModelCache` uses, for the same reason.
 */
export class GlbTemplateCache {
  private templates = new Map<string, GlbTemplate>();
  private inflight = new Map<string, Promise<GlbTemplate | null>>();
  private disposed = false;

  /** How many times a loader actually ran — the number `countFetches` asserts on. */
  loads = 0;

  /**
   * The template for `key`, loading it at most once.
   *
   * A `null` result is NOT cached: a missing asset is usually a transient
   * resolution failure (permission not yet granted, source still loading), and
   * remembering it would make the whole session act as if the asset were gone.
   */
  async getOrLoad(key: string, load: () => Promise<GlbTemplate | null>): Promise<GlbTemplate | null> {
    const cached = this.templates.get(key);
    if (cached) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    this.loads++;
    const promise = load()
      .then((template) => {
        if (template && !this.disposed) this.templates.set(key, template);
        return template;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Templates currently held, for diagnostics and tests. */
  get size(): number {
    return this.templates.size;
  }

  /**
   * Free every template's GPU resources.
   *
   * Only safe once the composed clones are out of the scene, because they share
   * exactly these geometries and materials — which is the whole point of the
   * cache and the reason disposal lives here rather than on the clones.
   */
  dispose(): void {
    this.disposed = true;
    const geometries = new Set<{ dispose(): void; disposeBoundsTree?: () => void }>();
    const materials = new Set<{ dispose(): void }>();
    for (const template of this.templates.values()) {
      template.root.traverse((node) => {
        const mesh = node as unknown as {
          geometry?: { dispose(): void; disposeBoundsTree?: () => void };
          material?: { dispose(): void } | { dispose(): void }[];
        };
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => materials.add(m));
        else if (mesh.material) materials.add(mesh.material);
      });
    }
    for (const g of geometries) {
      g.disposeBoundsTree?.();
      g.dispose();
    }
    for (const m of materials) m.dispose();
    this.templates.clear();
    this.inflight.clear();
  }
}

// ─── Result shape ────────────────────────────────────────────────────────

/** One resolved occurrence of a referenced file. */
export interface ComposedFrame {
  /** Occurrence address of everything INSIDE this frame. */
  occurrence: string;
  /** Occurrence address of the file the reference is written in. */
  parentOccurrence: string;
  /** 1 for a reference in the root scene. */
  depth: number;
  assetId: string;
  url: string;
  sha256: string;
  /** Byte length of the referenced file. Same for every occurrence of it. */
  sizeBytes: number;
  /** Identifies the FILE; shared by all occurrences of the same asset. */
  sourceKey: string;
  /** The reference node in the containing file. */
  referenceNode: Object3D;
  /** The grafted clone. */
  subtreeRoot: Object3D;
  /** This file's own signature state. */
  ownSignatureState: SignatureState;
  /** The weakest state along the resolution path — what actually counts. */
  effectiveState: SignatureState;
  signaturePresent: boolean;
  /** Nodes Three.js renamed in this occurrence → their pre-dedup names. */
  renamedNodes: Map<Object3D, string>;
  /** node → index in THIS file's `nodes[]`, keyed on this occurrence's clones. */
  gltfNodeIndices: Map<Object3D, number>;
  gltfNodeNames: readonly (string | undefined)[];
  /** The referenced file changed since the reference was written (F9). */
  updated: boolean;
}

/** A reference that could not be resolved. Reported; never a silent hole. */
export interface MissingReference {
  assetId: string;
  path?: string;
  occurrence: string;
  referenceNode: Object3D;
  reason: string;
  /**
   * The wireframe stand-in grafted under {@link referenceNode} (plan-703 §2.8).
   *
   * Part of the result rather than something a consumer has to build, because
   * the graft has to be undone by `dispose()` like every other one — and the
   * only list that knows how to do that lives inside `compose`.
   */
  placeholder: Object3D;
  /** Name shown for the placeholder; the file stem, else the id. */
  label: string;
}

export interface ComposeResult {
  /** Every resolved occurrence, outermost first. */
  frames: ComposedFrame[];
  /** Overrides whose target no longer exists (F9). */
  orphanedOverrides: OrphanedOverride[];
  /** References that resolved to nothing. */
  missing: MissingReference[];
  /** The subset of {@link frames} whose file changed since it was referenced. */
  updated: ComposedFrame[];
  /** How many templates were actually loaded — one per distinct asset. */
  loads: number;
  /** The cache backing this composition; `null` when the caller owns it. */
  ownedCache: GlbTemplateCache | null;
  /** Detach every grafted subtree and, when this composition owns the cache, free it. */
  dispose(): void;
}

export interface ComposeOptions {
  /** URL of the root file — the base for its own relative reference paths. */
  baseUrl: string;
  /** Content hash of the root file, when known. Derived NodeIds hang on it. */
  sha256?: string;
  /** node → index in the ROOT file's `nodes[]`, for root-level NodeId derivation. */
  gltfNodeIndices?: Map<Object3D, number>;
  signatureState?: SignatureState;
  signaturePresent?: boolean;
  /** Identity of the root file itself, so a self-reference reads as a cycle. */
  assetId?: string;
  resolve: ReferenceResolver;
  /** Reuse a cache across compositions. Omit and one is created and owned here. */
  cache?: GlbTemplateCache;
  /** Checked before and after every await; true abandons the composition. */
  shouldAbort?: () => boolean;
  maxDepth?: number;
}

// ─── Internals ───────────────────────────────────────────────────────────

interface Frame {
  assetId: string;
  baseUrl: string;
  signatureState: SignatureState;
  effectiveState: SignatureState;
  occurrence: string;
  depth: number;
  visited: ReadonlySet<string>;
  trail: string[];
}

/** The cache/cycle key of a reference: identity first, location second. */
function referenceKey(ref: AssetReference, resolvedPath: string): string {
  return ref.assetId ? `id:${ref.assetId}` : `url:${resolvedPath}`;
}

/**
 * Pair a template's nodes with a clone's.
 *
 * `Object3D.clone()` copies children in order, so a parallel walk pairs them
 * exactly. This is what carries the template's per-file glTF indices over to
 * each occurrence's own objects — without it the index map would keep pointing
 * at nodes that are not in the scene.
 */
function remapIndices(
  template: Object3D,
  clone: Object3D,
  templateIndices: Map<Object3D, number>,
): Map<Object3D, number> {
  const out = new Map<Object3D, number>();
  const walk = (t: Object3D, c: Object3D): void => {
    const index = templateIndices.get(t);
    if (index !== undefined) out.set(c, index);
    const count = Math.min(t.children.length, c.children.length);
    for (let i = 0; i < count; i++) walk(t.children[i], c.children[i]);
  };
  walk(template, clone);
  return out;
}

/**
 * The occurrence segment a reference node contributes.
 *
 * Its `NodeId` when it has one. When it does not — a scene written before ids
 * existed — an ordinal within its own file stands in: deterministic for the same
 * bytes, which is all the address needs to be, and far better than refusing to
 * compose the file at all.
 */
function occurrenceSegment(referenceNode: Object3D, ordinal: number): string {
  return getNodeId(referenceNode) ?? `@${ordinal}`;
}

// ─── compose ─────────────────────────────────────────────────────────────

/**
 * Resolve every `AssetReference` in `root` into one tree.
 *
 * Mutates `root`: each reference node gains its referenced subtree as a child.
 * Runs depth-first and grafts only AFTER the child has been composed, so the
 * strength ordering falls out of the recursion — an inner file's overrides are
 * applied before the outer file's, and the outer therefore wins (§2.4).
 */
export async function compose(root: Object3D, options: ComposeOptions): Promise<ComposeResult> {
  const cache = options.cache ?? new GlbTemplateCache();
  const ownedCache = options.cache ? null : cache;
  const maxDepth = options.maxDepth ?? MAX_REFERENCE_DEPTH;
  const shouldAbort = options.shouldAbort ?? ((): boolean => false);

  const frames: ComposedFrame[] = [];
  const orphanedOverrides: OrphanedOverride[] = [];
  const missing: MissingReference[] = [];
  const grafted: Array<{ parent: Object3D; child: Object3D }> = [];

  const rootState = options.signatureState ?? 'none';
  const rootLabel = options.assetId || options.baseUrl || '<root>';
  const rootKeys = new Set<string>();
  if (options.assetId) rootKeys.add(`id:${options.assetId}`);
  if (options.baseUrl) rootKeys.add(`url:${options.baseUrl}`);

  // The root file's own nodes get derived ids too, so a reference node in the
  // scene can contribute a stable occurrence segment. Files we write carry
  // authored ids already and keep them — `deriveNodeIdsForSubtree` skips those.
  if (options.sha256 && options.gltfNodeIndices) {
    const indices = options.gltfNodeIndices;
    await deriveNodeIdsForSubtree(root, options.sha256, (node) => indices.get(node));
  }

  const rootFrame: Frame = {
    assetId: options.assetId ?? '',
    baseUrl: options.baseUrl,
    signatureState: rootState,
    effectiveState: rootState,
    occurrence: ROOT_OCCURRENCE,
    depth: 0,
    visited: rootKeys,
    trail: [rootLabel],
  };

  const dispose = (): void => {
    for (let i = grafted.length - 1; i >= 0; i--) {
      const { parent, child } = grafted[i];
      parent.remove(child);
    }
    grafted.length = 0;
    ownedCache?.dispose();
  };

  const abort = (): never => {
    dispose();
    throw new ComposeAbortedError();
  };

  /** Resolve every reference in one already-parsed subtree. */
  const composeSubtree = async (subtreeRoot: Object3D, frame: Frame): Promise<void> => {
    // Collected BEFORE anything is grafted, so a composed child's own references
    // are handled by its own recursion and never a second time here.
    const references = collectReferenceNodes(subtreeRoot);
    let ordinal = 0;

    for (const { node: referenceNode, ref } of references) {
      if (shouldAbort()) abort();
      const segment = occurrenceSegment(referenceNode, ordinal++);
      const occurrence = childOccurrence(frame.occurrence, segment);
      const resolvedPath = ref.path ? resolveReferencePath(frame.baseUrl, ref.path) : '';
      const key = referenceKey(ref, resolvedPath);
      const label = ref.assetId || resolvedPath || '<unnamed>';

      if (frame.visited.has(key)) {
        dispose();
        throw new ReferenceCycleError([...frame.trail, label]);
      }
      if (frame.depth + 1 > maxDepth) {
        dispose();
        throw new ReferenceDepthError(frame.depth + 1, [...frame.trail, label]);
      }

      const context: ResolveContext = {
        baseUrl: frame.baseUrl,
        occurrence,
        depth: frame.depth,
        resolvedPath,
      };

      let template: GlbTemplate | null;
      try {
        template = await cache.getOrLoad(key, async () => {
          const resolved = await options.resolve(ref, context);
          if (!resolved) return null;
          const parsed = await parseGlbSubtreeWithMeta(resolved.bytes);
          const sha256 = resolved.sha256 ?? '';
          // Stamp derived ids on the TEMPLATE, so every clone inherits them for
          // free (`Object3D.copy` deep-copies `userData`). Doing it per clone
          // would hash the same file once per occurrence for an identical result.
          if (sha256) {
            await deriveNodeIdsForSubtree(parsed.root, sha256, (n) => parsed.gltfNodeIndices.get(n));
          }
          return {
            root: parsed.root,
            url: resolved.url,
            sha256,
            sizeBytes: resolved.bytes.byteLength,
            sourceKey: sha256 || resolved.url,
            signatureState: resolved.signatureState ?? 'none',
            signaturePresent: resolved.signaturePresent ?? false,
            gltfNodeIndices: parsed.gltfNodeIndices,
            gltfNodeNames: parsed.gltfNodeNames,
          };
        });
      } catch (e) {
        dispose();
        throw e;
      }
      if (shouldAbort()) abort();

      if (!template) {
        // A hole you can see and a hole you can read about (§2.8, F16). The
        // placeholder joins `grafted` so `dispose()` takes it out again — a
        // composition that half-tears-down is worse than one that never built.
        const placeholderLabel = missingReferenceLabel(ref);
        const placeholder = buildMissingReferencePlaceholder({
          label: placeholderLabel,
          bounds: ref.bounds,
          assetId: ref.assetId,
          path: ref.path,
        });
        referenceNode.add(placeholder);
        grafted.push({ parent: referenceNode, child: placeholder });
        missing.push({
          assetId: ref.assetId,
          path: ref.path,
          occurrence,
          referenceNode,
          reason: `Referenced asset could not be resolved: ${label}`,
          placeholder,
          label: placeholderLabel,
        });
        continue;
      }

      const clone = template.root.clone(true);
      const gltfNodeIndices = remapIndices(template.root, clone, template.gltfNodeIndices);
      const renamedNodes = remapRenamedNodes(template.root, clone);
      const effectiveState = weakestSignatureState(frame.effectiveState, template.signatureState);

      const childFrame: Frame = {
        assetId: ref.assetId,
        // Relative paths inside the referenced file resolve against ITS url (F18).
        baseUrl: template.url,
        signatureState: template.signatureState,
        effectiveState,
        occurrence,
        depth: frame.depth + 1,
        visited: new Set([...frame.visited, key]),
        trail: [...frame.trail, label],
      };

      // Depth-first: the child resolves and applies ITS overrides before this
      // file applies its own, which is exactly the strength ordering (§2.4).
      await composeSubtree(clone, childFrame);
      if (shouldAbort()) abort();

      referenceNode.add(clone);
      grafted.push({ parent: referenceNode, child: clone });

      const overrides = getAssetOverrides(referenceNode);
      if (overrides) {
        const result = applyAssetOverrides(overrides, makeSubtreeResolvers(clone), {
          occurrence,
          assetId: ref.assetId,
        });
        orphanedOverrides.push(...result.orphaned);
      }

      const updated = !!ref.sha256 && !!template.sha256 && ref.sha256 !== template.sha256;
      frames.push({
        occurrence,
        parentOccurrence: frame.occurrence,
        depth: childFrame.depth,
        assetId: ref.assetId,
        url: template.url,
        sha256: template.sha256,
        sizeBytes: template.sizeBytes,
        sourceKey: template.sourceKey,
        referenceNode,
        subtreeRoot: clone,
        ownSignatureState: template.signatureState,
        effectiveState,
        signaturePresent: template.signaturePresent,
        renamedNodes,
        gltfNodeIndices,
        gltfNodeNames: template.gltfNodeNames,
        updated,
      });
    }
  };

  await composeSubtree(root, rootFrame);

  if (frames.length > 0) {
    debug('loader', `Composition: ${frames.length} occurrence(s) from ${cache.size} file(s), `
      + `${cache.loads} load(s), ${missing.length} unresolved, ${orphanedOverrides.length} orphaned override(s)`);
  }

  return {
    frames,
    orphanedOverrides,
    missing,
    updated: frames.filter((f) => f.updated),
    loads: cache.loads,
    ownedCache,
    dispose,
  };
}

/**
 * Carry the template's `_rvOrigName` stamps over as a clone-keyed map.
 *
 * `detectRenamedNodes` ran on the template, so the stamps travel with the
 * clone's `userData` already — but `registerNodeAliases` wants the Map form,
 * keyed on the objects that are actually in the scene.
 */
function remapRenamedNodes(template: Object3D, clone: Object3D): Map<Object3D, string> {
  const out = new Map<Object3D, string>();
  const walk = (t: Object3D, c: Object3D): void => {
    const orig = (t.userData as Record<string, unknown> | undefined)?.['_rvOrigName'];
    if (typeof orig === 'string' && orig.length > 0) out.set(c, orig);
    const count = Math.min(t.children.length, c.children.length);
    for (let i = 0; i < count; i++) walk(t.children[i], c.children[i]);
  };
  walk(template, clone);
  return out;
}

/** True when this tree has anything for {@link compose} to do. */
export function hasReferences(root: Object3D): boolean {
  return collectReferenceNodes(root).length > 0;
}

/** The composed subtrees a gated frame contributed, as a node set for the loader. */
export function collectGatedNodes(
  result: ComposeResult,
  rootState: SignatureState,
  allowUntrustedLogic: boolean,
): Set<Object3D> {
  const gated = new Set<Object3D>();
  for (const frame of result.frames) {
    if (!isFrameGated(frame.effectiveState, rootState, allowUntrustedLogic)) continue;
    frame.subtreeRoot.traverse((node) => gated.add(node));
    // The reference node itself belongs to the CONTAINING file and keeps that
    // file's trust — only what came out of the untrusted bytes is gated.
  }
  return gated;
}
