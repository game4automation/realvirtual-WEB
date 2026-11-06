// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * baked-load-allowlist.ts — the test files that load a GLB WITHOUT the
 * destructive bake, and the reason each one is allowed to (plan-772 F4/E1).
 *
 * ## Why a list and not a convention
 *
 * The bake is gated on `options.bakeRegistry` (see
 * `tests/helpers/load-baked-glb.ts` for the 117-vs-78 measurement). When
 * plan-772 counted, **67 test files called `loadGLB` and 49 passed no
 * registry** — they assert against the authoring tree and go green while the
 * production tree is broken. A convention with 49 violations is not a
 * convention, so the state is written down here instead: a file in this list
 * loads unbaked ON PURPOSE, every other file must bake.
 *
 * `tests/bake-test-path-enforced.node.test.ts` enforces it in both directions:
 * an unlisted file that loads unbaked fails, and a listed file that no longer
 * does (or no longer exists) fails as a stale entry. So the second group below
 * can only shrink.
 *
 * ## The two groups are not the same debt
 *
 * - {@link AUTHORING_LOADS} declare `preserveHierarchy` — the asset editor,
 *   save/reload, composition and export suites. They test the authoring tree
 *   because the authoring tree is their subject. These are legitimate and are
 *   not expected to shrink.
 * - {@link UNREVIEWED_LEGACY_LOADS} declare nothing. They neither bake nor say
 *   they are authoring loads: they simply predate the insight and silently
 *   assert about a tree production never builds. **This is the group to work
 *   off.** plan-772 Phase 1 deliberately did not rewrite them (the plan's
 *   scope was the enforcement, not 49 conversions); each one needs a look at
 *   what it actually claims. A file here whose claims are about node
 *   existence, poses, references or picking is a latent blind spot of exactly
 *   the kind that hid the robot TCP for weeks (plan-772 B2).
 *
 * Paths are relative to the `tests/` directory of the repo the file lives in,
 * with forward slashes.
 */

/** One allowlist entry: the file, and why it may load unbaked. */
export interface AllowedUnbakedLoad {
  /** Path relative to `tests/`, forward slashes. */
  readonly file: string;
  /** Why this file loads the authoring tree on purpose. */
  readonly reason: string;
}

/** Shared reason text for the declared authoring suites. */
const AUTHORING = 'authoring load: declares preserveHierarchy — the authoring tree IS its subject '
  + '(editor, save/reload, composition, export)';

/** Shared reason text for the files that never declared anything. */
const UNREVIEWED = 'legacy (plan-772 Phase 1): loads without a registry and without declaring an '
  + 'authoring load — not yet reviewed for bake relevance';

/**
 * Suites whose subject is the authoring tree, declared by `preserveHierarchy`.
 * Not expected to shrink.
 */
export const AUTHORING_LOADS: ReadonlyArray<AllowedUnbakedLoad> = [
  'bypath-to-address-migration.test.ts',
  'compose-missing-references.test.ts',
  'descend-override-suppression.test.ts',
  'display-name-not-identity.test.ts',
  'document-classification.test.ts',
  'editor-save-authored-names.test.ts',
  'editor-setfield-reference-shape.test.ts',
  'glb-bake-roundtrip.test.ts',
  'web-operator-panel-config-persistence.test.ts',
  'glb-composition.test.ts',
  'glb-flatten-export.test.ts',
  'glb-reference-loader-phases.test.ts',
  'glb-reference-nfr.test.ts',
  'glb-reference-trust.test.ts',
  'helpers/op-identity-fixture.ts',
  'id-index-invariant.test.ts',
  'instantiate-subtree.test.ts',
  'logicstep-enable-target-address.test.ts',
  'mauser-editor-roundtrip.test.ts',
  'mcp-path-contract.test.ts',
  'no-trs-override.test.ts',
  'path/path-block-loaded-edit.test.ts',
  'phase1-persists-no-id.test.ts',
  'placement-any-document.test.ts',
  'replay-recording-web-save-refs.test.ts',
  'resolve-ref-scope.test.ts',
  'ribbon-demo-glb.test.ts',
  'ribbon-line-stop.test.ts',
  'ribbon-unity-export.test.ts',
  'rv-asset-glb-export.test.ts',
  'rv-cadlink-reimport.test.ts',
  'rv-document-stack-recompose.test.ts',
  'rv-kinematic-save-reload-cycle.test.ts',
  'rv-lamp-manager-order.test.ts',
  'rv-mcp-macro-e2e.test.ts',
  'rv-scene-glb-bake-fmu.test.ts',
  'save-atomicity-and-ensure-id.test.ts',
  'save-id-only.test.ts',
  'signal-address-persistence.test.ts',
  'unity-reexport-stability.test.ts',
].map((file) => ({ file, reason: AUTHORING }));

/**
 * The real debt: files that load unbaked without saying so. Work this list
 * off by switching the file to `loadBakedGLB` (and removing its line here), or
 * — when the authoring tree really is its subject — by declaring
 * `preserveHierarchy` and moving the line up into {@link AUTHORING_LOADS}
 * with a reason of its own.
 */
export const UNREVIEWED_LEGACY_LOADS: ReadonlyArray<AllowedUnbakedLoad> = [
  'alias-stats.test.ts',
  'badge-tooltip.test.tsx',
  'bind-reload-lamp-draft.test.ts',
  'demo-scene-signal-placement.test.ts',
  'des-source-pose-handover.test.ts',
  'glb-name-dedup-alias.test.ts',
  'inspector-plc-bind-row.test.tsx',
  'mu-preplaced.test.ts',
  'reference-audit-problems.test.ts',
  'rv-kinematic-parenting.test.ts',
  'rv-sig-verify.test.ts',
  'writer-inventory-demo-model.test.ts',
].map((file) => ({ file, reason: UNREVIEWED }));

/** Every file allowed to load a GLB without the destructive bake. */
export const ALLOWED_UNBAKED_LOADS: ReadonlyArray<AllowedUnbakedLoad> = [
  ...AUTHORING_LOADS,
  ...UNREVIEWED_LEGACY_LOADS,
];

/** `file` → reason, for the enforcement test's messages. */
export const ALLOWED_UNBAKED_BY_FILE: ReadonlyMap<string, string> = new Map(
  ALLOWED_UNBAKED_LOADS.map((e) => [e.file, e.reason]),
);
