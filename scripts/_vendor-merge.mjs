// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _vendor-merge — the three-way merge that lets a customer receive updates
 * without losing their own work (plan-700 §2.4, §2.5, §2.7).
 *
 * ## The problem
 *
 * A delivered `projects/<key>/` is two things at once: our shipped material
 * (models, docs, CONNECT config) and the customer's working directory (their
 * scenes, their settings, their layouts). The delivery pipeline could only do
 * all-or-nothing per folder, so it chose nothing — and consequently **no
 * project-side update has reached a delivered customer since their first
 * delivery**, while everything outside the project folder was silently
 * replaced at every delivery.
 *
 * ## The model
 *
 * Three zones with three different rules:
 *
 *   A — everything outside `projects/**`: replaced, drift reported.
 *   B — paths matching a `vendor.managed` glob: three-way merged, here.
 *   C — everything else in the project: never touched.
 *
 * The default is asymmetric on purpose: **unknown means zone C**. A forgotten
 * vendor glob costs one update that did not arrive; a glob that is too wide
 * costs customer data. Only the first mistake is repairable.
 *
 * ## Why three-way and not two
 *
 * With only "ours" and "theirs" you cannot tell *changed* from *new*, and you
 * cannot tell *deleted on purpose* from *never delivered*. The project's own
 * `resolveSceneConflict` has exactly that gap. The third party here is the
 * previous delivery, identified in the customer repository by the tag
 * `delivery/<version>`.
 *
 * ## Why the hash is a Git blob OID
 *
 * Every path and hash fed into {@link mergeVendorTree} comes from
 * `git ls-files -s`, on **both** sides. Not from the working tree, and never
 * from `git hash-object` outside a repository:
 *
 *   - **LFS-immune** — Git stores the pointer blob whatever the smudge filter
 *     did on the delivering machine. Hashing the checkout would make the same
 *     unchanged 300 MB GLB hash differently on two developers' machines and
 *     report every vendor file as conflicted.
 *   - **CRLF-immune** — the OID is the normalised repository content.
 *   - **Path-normalised and case-correct** — Git yields forward slashes and the
 *     spelling it tracks, not the one a case-insensitive Windows filesystem
 *     reports. Without that, `projects/Toray` in the base versus
 *     `projects/toray` in the clone produces a `delete`, i.e. data loss.
 *
 * The whole decision layer is pure: maps in, actions out, no I/O. That is what
 * makes all nine cases testable without temporary repositories.
 */

import { globRegex } from './_rv-fs-utils.mjs';

/** Result of classifying one path against a project's vendor globs. */
export const PATH_CLASS = Object.freeze({ vendor: 'vendor', customer: 'customer' });

/** Every action {@link mergeVendorTree} can decide on. */
export const MERGE_ACTION = Object.freeze({
  /** Write the staged file; the customer never had it. */
  add: 'add',
  /** Write the staged file; the customer had ours, unmodified. */
  update: 'update',
  /** Nothing to do — the customer already has exactly this content. */
  noop: 'noop',
  /** Remove it; we no longer ship it and the customer never touched it. */
  delete: 'delete',
  /** Leave the customer's file exactly as it is. */
  keepCustomer: 'keep-customer',
  /** Respect a deliberate deletion — do not restore the file (F4). */
  keepDeleted: 'keep-deleted',
  /** We ship it, the customer does not have it, and there is no baseline to judge by. */
  addPending: 'add-pending',
});

/** Why a path ended up in the conflict list. */
export const CONFLICT_REASON = Object.freeze({
  bothChanged: 'both-changed',
  addedBothSides: 'added-both-sides',
  deletedByVendorChangedByCustomer: 'deleted-by-vendor-changed-by-customer',
  deletedByCustomer: 'deleted-by-customer',
  missingWithoutBaseline: 'missing-without-baseline',
});

/**
 * Classifies one project-relative path as vendor-managed or customer-owned.
 *
 * `handover` beats `managed`: more specific wins, with no ordering semantics of
 * its own, so a manifest cannot change meaning by having its lists sorted.
 */
export function classifyPath(relPath, vendorGlobs) {
  // A sidecar we parked during an earlier conflict is neither side's content: it is
  // the record OF a conflict. It also sits, by construction, right next to its
  // original and therefore inside the same managed glob — so without this rule the
  // NEXT delivery sees a vendor path it no longer ships, finds it unmodified since
  // the baseline, and deletes it (case 7). The customer would lose the version we
  // handed them precisely so they could compare. Cleaning sidecars up is their
  // decision, not something a later delivery does behind their back.
  if (isSidecarPath(relPath)) return PATH_CLASS.customer;
  if (!vendorGlobs) return PATH_CLASS.customer;
  const managed = Array.isArray(vendorGlobs.managed) ? vendorGlobs.managed : [];
  const handover = Array.isArray(vendorGlobs.handover) ? vendorGlobs.handover : [];
  if (handover.some((glob) => globRegex(glob).test(relPath))) return PATH_CLASS.customer;
  if (managed.some((glob) => globRegex(glob).test(relPath))) return PATH_CLASS.vendor;
  return PATH_CLASS.customer;
}

/**
 * Throws when a map holds two paths differing only in case.
 *
 * On a case-insensitive filesystem those are the same file, and letting them
 * through means a `delete` decided against the wrong entry — the failure mode
 * that costs customer data rather than an update.
 */
function assertNoCaseCollisions(map, label) {
  if (!map) return;
  const seen = new Map();
  for (const path of Object.keys(map)) {
    const lower = path.toLowerCase();
    const previous = seen.get(lower);
    if (previous !== undefined && previous !== path) {
      throw new Error(`${label} contains two paths differing only in case: "${previous}" and "${path}".`);
    }
    seen.set(lower, path);
  }
}

/**
 * Decides what happens to every vendor path, given three snapshots.
 *
 * All three inputs are maps `path -> blobOid`; a path absent from a map means
 * the file does not exist on that side. `baseline === null` means there is no
 * previous delivery to compare against.
 *
 * @param baseline     the previous delivery's state in the customer repository
 *                     (`git ls-files -s --with-tree=<baselineTag>`), or `null`
 * @param customer     the customer's current state (`git ls-files -s`)
 * @param staged       what this delivery would ship
 * @param vendorGlobs  the project's `vendor` block
 * @param remoteEmpty  true only for the very first seeding of an empty remote
 * @param seedMissing  allow `add-pending` paths to be created after a human said so
 * @param customerOwned  paths the customer kept in an EARLIER conflict; see below
 */
export function mergeVendorTree({
  baseline, customer, staged, vendorGlobs,
  remoteEmpty = false, seedMissing = false, customerOwned = [],
}) {
  assertNoCaseCollisions(baseline, 'baseline');
  assertNoCaseCollisions(customer, 'customer');
  assertNoCaseCollisions(staged, 'staged');

  const baselineMissing = baseline === null || baseline === undefined;
  // Once a conflict has been resolved in the customer's favour, THEIR content is
  // what the next baseline records — so on the delivery after that, `c === b` holds
  // and case 3 would overwrite their kept version without a word. That is the same
  // silent loss F2 exists to prevent, just one delivery later. The set of paths they
  // kept therefore travels forward in the delivery manifest, and while a path is in
  // it, "unchanged since the baseline" no longer means "never touched".
  const held = new Set(customerOwned);
  const actions = {};
  const conflicts = [];
  const paths = [...new Set([
    ...Object.keys(baseline ?? {}),
    ...Object.keys(customer ?? {}),
    ...Object.keys(staged ?? {}),
  ])].sort();

  for (const path of paths) {
    const b = baselineMissing ? null : (baseline[path] ?? null);
    const c = (customer ?? {})[path] ?? null;
    const s = (staged ?? {})[path] ?? null;

    // Case 1 — not vendor territory. Never touched, never reported: zone C is
    // the customer's, and mentioning every one of their files in the report
    // would bury the entries that matter.
    if (classifyPath(path, vendorGlobs) !== PATH_CLASS.vendor) {
      actions[path] = MERGE_ACTION.keepCustomer;
      continue;
    }

    // Case 4 — already identical. Checked before everything else because it is
    // the overwhelmingly common case and needs no baseline at all.
    if (c !== null && c === s) {
      actions[path] = MERGE_ACTION.noop;
      continue;
    }

    if (baselineMissing) {
      // No previous delivery to judge by. The two sub-cases differ sharply:
      //
      //  - Empty remote: this is the first seeding, everything is simply new.
      //  - Remote with content but no delivery tag (a customer from before
      //    plan-700): "we never sent it" and "they deleted it on purpose" look
      //    identical, so creating the file would silently undo a deliberate
      //    deletion — the very thing F4 forbids, and it would hit exactly the
      //    two existing customers. It becomes an `add-pending` question in the
      //    report instead, answered by a human with --seed-missing.
      if (c === null && s !== null) {
        if (remoteEmpty || seedMissing) {
          actions[path] = MERGE_ACTION.add;
        } else {
          actions[path] = MERGE_ACTION.addPending;
          conflicts.push({ path, reason: CONFLICT_REASON.missingWithoutBaseline, sidecar: false });
        }
        continue;
      }
      // Present on both sides and different: without a baseline we cannot know
      // whether the customer changed it, so we do not touch it.
      actions[path] = MERGE_ACTION.keepCustomer;
      continue;
    }

    // Case 9 — the customer deleted a file we had delivered. Never restore it
    // (F4); re-delivering it would undo a deliberate act with no trace.
    if (c === null && b !== null) {
      if (s === null) { actions[path] = MERGE_ACTION.noop; continue; }
      actions[path] = MERGE_ACTION.keepDeleted;
      conflicts.push({ path, reason: CONFLICT_REASON.deletedByCustomer, sidecar: false });
      continue;
    }

    // Case 2 — genuinely new vendor file.
    if (c === null && b === null && s !== null) {
      actions[path] = MERGE_ACTION.add;
      continue;
    }

    // A path the customer kept in an earlier conflict counts as theirs, however
    // equal to the baseline it looks now (see `held` above).
    const kept = held.has(path) && c !== null;

    // Cases 7 and 8 — we stopped shipping it.
    if (s === null) {
      if (c === b && !kept) { actions[path] = MERGE_ACTION.delete; continue; }
      actions[path] = MERGE_ACTION.keepCustomer;
      conflicts.push({ path, reason: CONFLICT_REASON.deletedByVendorChangedByCustomer, sidecar: false });
      continue;
    }

    // Case 3 — the customer never touched it, so the update is safe.
    if (c === b && !kept) {
      actions[path] = MERGE_ACTION.update;
      continue;
    }

    // Cases 5 and 6 — both sides have content and they disagree. The customer
    // wins, always; the new version is offered alongside as a sidecar so the
    // change is visible rather than lost.
    actions[path] = MERGE_ACTION.keepCustomer;
    conflicts.push({
      path,
      reason: b === null ? CONFLICT_REASON.addedBothSides : CONFLICT_REASON.bothChanged,
      sidecar: true,
    });
  }

  return { actions, conflicts, baselineMissing };
}

// ─── Sidecars ────────────────────────────────────────────────────────────

/**
 * Builds the path a conflicting vendor version is parked at, **keeping the
 * extension last**.
 *
 * `models/a.glb` becomes `models/a.vendor-6.3.0.glb`, not
 * `models/a.glb.vendor-6.3.0`. The naive form was the original design and is a
 * real hazard: it no longer matches the `*.glb` rule in `.gitattributes`, so a
 * several-hundred-megabyte GLB would enter the customer's Git history as a raw
 * blob instead of an LFS pointer, and trip the delivery size guard on the way.
 *
 * Double extensions (`.tar.gz`) are not special-cased — `a.tar.gz` becomes
 * `a.tar.vendor-X.gz`. Accepted as a documented limit rather than guessed at.
 */
/**
 * True for a path {@link sidecarPathFor} could have produced.
 *
 * Deliberately loose: the version segment is only required to start with a digit,
 * because it may itself contain dots (`6.3.0`) and no delimiter separates it from
 * the extension. A false positive costs one update that does not arrive at a file
 * that happens to be named like a sidecar; a false negative costs the customer a
 * file we told them to compare against. Only the first is recoverable.
 */
export function isSidecarPath(relPath) {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return /\.vendor-[0-9][0-9A-Za-z.+_-]*$/.test(name);
}

export function sidecarPathFor(relPath, version) {
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash + 1);
  const name = relPath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // A leading dot is part of the name (`.gitignore`), not an extension.
  if (dot <= 0) return `${dir}${name}.vendor-${version}`;
  return `${dir}${name.slice(0, dot)}.vendor-${version}${name.slice(dot)}`;
}

/**
 * True when a sidecar may be written, i.e. it lands under the same
 * `.gitattributes` rule as its original.
 *
 * The extension-preserving name above covers suffix globs (`*.glb`), but this
 * repository also pins exact paths on purpose. If a sidecar path escapes its
 * original's rule, **no sidecar is written** and the conflict is reported in
 * text only. A missing sidecar costs the customer a lookup; a 300 MB raw blob
 * costs them their repository.
 *
 * @param attributeOf  `(path) => string|null`, typically wrapping
 *                     `git check-attr filter -- <path>`
 */
export function sidecarIsSafe(relPath, sidecarPath, attributeOf) {
  return attributeOf(relPath) === attributeOf(sidecarPath);
}

/**
 * Extracts the attribute VALUE from `git check-attr` output.
 *
 * `git check-attr filter -- models/a.glb` answers
 * `models/a.glb: filter: lfs` — the path is part of the line, so comparing raw
 * outputs for two different paths can never be equal and
 * {@link sidecarIsSafe} would refuse every sidecar in existence. Parsing lives
 * here rather than in each caller so that mistake can only be made once.
 */
export function parseCheckAttr(output) {
  const match = /:\s*[^:]+:\s*(.+?)\s*$/.exec((output ?? '').trim());
  return match ? match[1] : null;
}

// ─── project.json (§2.7) ─────────────────────────────────────────────────

/** Manifest fields we own: the schema-update channel. */
const VENDOR_MANIFEST_FIELDS = Object.freeze(['schemaVersion', 'vendor', 'canonicalName']);

/**
 * Manifest sections we own, but entry-wise: an entry whose `path` falls under
 * `vendor.handover` stays the customer's.
 */
const VENDOR_MANIFEST_SECTIONS = Object.freeze(['models', 'library', 'docs', 'aasx', 'connect', 'rag', 'plugins']);

/**
 * Merges the one file that carries both zones.
 *
 * Everything not named as vendor stays the customer's, including fields neither
 * side knows about — that is plan-370's rule R3 and the reason an older client
 * cannot silently drop a newer client's section.
 *
 * A customer manifest that will not parse is **not** merged: the customer's file
 * stays, the new one goes beside it as a sidecar, and the report says so. A
 * merge into a file we do not understand is a guess, and guessing here means
 * writing over a project index.
 */
export function mergeProjectManifest(customerManifest, vendorManifest, vendorGlobs) {
  if (!vendorManifest || typeof vendorManifest !== 'object' || Array.isArray(vendorManifest)) {
    throw new Error('The delivered project.json must be a JSON object.');
  }
  if (!customerManifest || typeof customerManifest !== 'object' || Array.isArray(customerManifest)) {
    return { merged: null, unreadable: true, changed: [] };
  }

  const merged = { ...customerManifest };
  const changed = [];

  for (const field of VENDOR_MANIFEST_FIELDS) {
    if (!(field in vendorManifest)) continue;
    if (JSON.stringify(merged[field]) === JSON.stringify(vendorManifest[field])) continue;
    merged[field] = vendorManifest[field];
    changed.push(field);
  }

  for (const section of VENDOR_MANIFEST_SECTIONS) {
    if (!(section in vendorManifest)) continue;
    const incoming = vendorManifest[section];
    if (Array.isArray(incoming)) {
      // Entry-wise: a handover entry the customer added or edited survives a
      // section that is otherwise ours to replace.
      const kept = Array.isArray(merged[section])
        ? merged[section].filter((entry) => typeof entry?.path === 'string'
          && classifyPath(`${section}/${entry.path}`, vendorGlobs) === PATH_CLASS.customer)
        : [];
      const keptPaths = new Set(kept.map((entry) => entry.path));
      const next = [...incoming.filter((entry) => !keptPaths.has(entry?.path)), ...kept];
      if (JSON.stringify(next) !== JSON.stringify(merged[section])) {
        merged[section] = next;
        changed.push(section);
      }
      continue;
    }
    if (JSON.stringify(merged[section]) === JSON.stringify(incoming)) continue;
    merged[section] = incoming;
    changed.push(section);
  }

  return { merged, unreadable: false, changed };
}

// ─── delivery-manifest.json v2 (§2.4) ────────────────────────────────────

/** Current delivery-manifest schema version. */
export const DELIVERY_MANIFEST_VERSION = 2;

/** The Git tag a delivery leaves behind, and reads back as its next baseline. */
export function baselineTagFor(version) {
  return `delivery/${version}`;
}

/**
 * Reads the merge basis out of a delivery manifest, tolerating v1.
 *
 * A v1 manifest (every repository delivered before plan-700) carries no
 * `baselineTag`, which is the honest answer "there is no basis" — and the
 * caller must then take the no-baseline path rather than assume one.
 */
export function readDeliveryManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifestVersion: 1, baselineTag: null, projects: {} };
  }
  const version = Number.isInteger(raw.manifestVersion) ? raw.manifestVersion : 1;
  if (version < DELIVERY_MANIFEST_VERSION) {
    return { ...raw, manifestVersion: version, baselineTag: null, projects: {} };
  }
  return {
    ...raw,
    manifestVersion: version,
    baselineTag: typeof raw.baselineTag === 'string' && raw.baselineTag ? raw.baselineTag : null,
    projects: raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {},
  };
}

/**
 * Adds the v2 fields to an existing (v1-shaped) delivery manifest.
 *
 * Additive: `coreCommit`, `privateCommit`, `profile` and the rest keep their
 * names and meaning, so a manifest written here is still readable by anything
 * that only knew v1.
 *
 * Note what is deliberately NOT here: a per-file hash map. The customer
 * repository already maintains a complete, trustworthy hash tree — its own
 * history — and a second one in JSON would be ~150 KB of churn per delivery
 * that is *also* incomplete, because it can only know paths we sent. Files the
 * customer created themselves would never appear in it and would be deleted
 * without ever being reported (§2.4).
 */
export function withDeliveryBaseline(base, { version, projects }) {
  return {
    manifestVersion: DELIVERY_MANIFEST_VERSION,
    ...base,
    baselineTag: baselineTagFor(version),
    projects: Object.fromEntries(Object.entries(projects ?? {}).map(([key, project]) => [key, {
      projectSchemaVersion: project?.schemaVersion ?? null,
      vendorGlobs: {
        managed: [...(project?.vendor?.managed ?? [])],
        handover: [...(project?.vendor?.handover ?? [])],
      },
    }])),
  };
}

// ─── Git blob-OID maps (§2.4) ────────────────────────────────────────────

/**
 * Parses the output of `git ls-files -s -z` into a `path -> blobOid` map.
 *
 * Kept separate from the process call so the parsing is testable and so the
 * caller can decide how to run Git (both sides use the same function, which is
 * the whole point: `git hash-object` in a directory without a `.git` bypasses
 * the LFS clean filter and would hash the real binary on one side and the
 * pointer on the other).
 */
export function parseLsFiles(output) {
  const map = {};
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, oid] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    if (oid && path) map[path] = oid;
  }
  return map;
}

/**
 * Parses the output of `git ls-tree -r -z <tree>` into a `path -> blobOid` map.
 *
 * This is how the BASELINE side is read. §2.4 named `git ls-files -s
 * --with-tree=<tag>`, but that option merges the tree into the *index* listing
 * and the index wins for every path present on both sides — so for exactly the
 * files that changed, it returns the customer's OID instead of the baseline's,
 * turning a real conflict into a silent "unchanged". `ls-tree` reads the tree
 * and nothing but the tree, which is what the design asks for.
 *
 * Its records are `<mode> <type> <oid>\t<path>`, one field more than
 * `ls-files -s`, hence the separate parser rather than a shared one with a
 * positional argument nobody would get right twice.
 */
export function parseLsTree(output) {
  const map = {};
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    if (type === 'blob' && oid && path) map[path] = oid;
  }
  return map;
}

/**
 * Restricts a blob-OID map to one project and re-keys it to project-relative
 * paths, which is the vocabulary the vendor globs are written in.
 */
export function projectSubtree(map, projectKey) {
  const prefix = `projects/${projectKey}/`;
  const out = {};
  for (const [path, oid] of Object.entries(map)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = oid;
  }
  return out;
}

/**
 * Carries the "kept by the customer" set forward to the next delivery.
 *
 * A path enters the set when a conflict was resolved in the customer's favour on
 * content, and leaves it as soon as the divergence ends — because they adopted our
 * version (`noop`), or because we wrote/removed the file with their consent
 * (`add`/`update`/`delete`, which only happen when the path is not held).
 *
 * Deletions are NOT carried: "the customer deleted it" is already answered by the
 * baseline on every future delivery, and keeping it here would grow the list for
 * ever with entries that decide nothing.
 */
export function nextCustomerOwned(previous, result) {
  const next = new Set(Array.isArray(previous) ? previous : []);
  for (const [path, action] of Object.entries(result.actions)) {
    if (action === MERGE_ACTION.add || action === MERGE_ACTION.update
      || action === MERGE_ACTION.delete || action === MERGE_ACTION.noop) next.delete(path);
  }
  for (const conflict of result.conflicts) {
    if (conflict.reason === CONFLICT_REASON.deletedByCustomer
      || conflict.reason === CONFLICT_REASON.missingWithoutBaseline) continue;
    next.add(conflict.path);
  }
  return [...next].sort();
}

/** Groups merge actions into the counts the CLI line and the report show. */
export function summariseMerge(result) {
  const counts = { add: 0, update: 0, delete: 0, keepCustomer: 0, keepDeleted: 0, addPending: 0, noop: 0 };
  for (const action of Object.values(result.actions)) {
    if (action === MERGE_ACTION.add) counts.add++;
    else if (action === MERGE_ACTION.update) counts.update++;
    else if (action === MERGE_ACTION.delete) counts.delete++;
    else if (action === MERGE_ACTION.keepDeleted) counts.keepDeleted++;
    else if (action === MERGE_ACTION.addPending) counts.addPending++;
    else if (action === MERGE_ACTION.noop) counts.noop++;
    else counts.keepCustomer++;
  }
  return { ...counts, conflicts: result.conflicts.length };
}
