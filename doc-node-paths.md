# Node Paths and Addresses — How References Are Written and Resolved

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-10-22 (plan-769).
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

**Since plan-769 a stored reference is an ADDRESS, and a node path is input and display.**
Component references, path fields, overrides and signal mappings that the viewer writes name
their target by its identity (`#<NodeId>`), so renaming, moving or re-importing a node no longer
breaks them. A node path — the slash-separated chain of names — is what a person, a plugin, an
MCP call or a Unity export hands in, and what the inspector shows; it is resolved once, on input
or on load, and never written back as the reference. Section 0 is the model; sections 1–10
describe the path layer underneath it (how names are built, how a path resolves, where it breaks),
which still matters for every file Unity writes and for every path a caller types.

Related: [doc-unity-to-web.md](doc-unity-to-web.md) (export pipeline),
[doc-signal-architecture.md](doc-signal-architecture.md) (signal flow),
[doc-persistence.md](doc-persistence.md) §2.0-0a (overrides),
[schema/v1/rv-odt.json](schema/v1/rv-odt.json) and
[schema/v1/specification.md](schema/v1/specification.md) §5a/§5b/§6 (format definition).

---

## 0. References are addresses, paths are input (plan-769)

### 0.1 Identity

Every node has an IDENTITY (`identityIdOf`, [`rv-decode-identity.ts`](src/core/engine/rv-decode-identity.ts)):

| Source | Id | When |
|---|---|---|
| authored `extras.realvirtual.NodeId` | as written | a file the viewer saved, or any producer that writes ids |
| decode seed | UUIDv5 of the node's canonical AUTHORED path in its file (`seedNodeIdsForFile`, `rv-node-id-seed.mjs`) — order-independent, the same in every session and in the Node scripts | every node without an authored id (every Unity export) |
| minted | UUIDv4 | a node the web creates (op, planner placement, clone) |

A seed is stored as runtime state (`userData._rvNodeId`), never as `NodeId`, until a save writes
it: then it becomes the authored id, so the ids a file had at load are the ids it has after the
save. A duplicated id in the input is re-minted deterministically on every node but the first
(`node-id-duplicate-reminted`). Composition no longer derives sha256 ids (plan-769 F12; the
`deriveNodeIdsForSubtree` helper is deprecated). Ids are unique **within a file**; the full
address adds the occurrence chain (§1a).

### 0.2 The address table

An address is relative to the **document that holds the reference** — the file the referring
component is stored in:

| Address | Target |
|---|---|
| `#<id>` | a node of the same file |
| `<p>#<id>` | a node inside the placement whose reference node has id `p` |
| `<p>/<b>#<id>` | a node inside the nested reference `b` of that placement, and so on per level |

The same rule addresses `AssetOverrides` keys, relative to the referenced asset: `#<id>` is a node
of the placed asset, `<b>#<id>` a node of its nested reference `b` (doc-persistence §2.0-0a).
`#<rootId>` of a placed asset is the placement root itself.

### 0.3 Stored forms

| Where | Stored by the viewer (file with `idVersion: 1`) | Read too |
|---|---|---|
| `ComponentReference` | `{ type, address, componentType, componentIndex? }`; unresolvable: `{ type, unresolvedPath, reason, componentType }` | `{ type, path, componentType }` — Unity and every file without `idVersion` |
| declared path fields (`Kinematic.Parent`, CRI `targetObjects`, `WebPhysicsZone.StaticColliders`, connection ends, `LogicStep_Enable.Target`, `RobotIK.TCP`) and NAME fields (`Source.ThisObjectAsMU`) | `{ address }` / `{ unresolvedPath, reason }` | the plain string |
| `AssetOverrides` | `byAddress` | `byNodeId` (as `#id`), `byPath` (migrated when applied); the removed `trsByNodeId` only counted |
| `SignalMapping` | `componentAddress`, `sourceAddress` | `componentPath`, `sourcePath` |
| file marker | `scenes[0].extras.realvirtual.idVersion = 1` | absent = path era; `> 1` = `id-version-newer` warning, references read unchanged |

`reason` is `missing`, `ambiguous` or `synthetic-target`. An unresolved path is kept verbatim and
never guessed — it is the next reader's job, and the Problems panel's.

### 0.4 Load → identity → save

<figure>
<svg class="rv-d" viewBox="0 0 760 230" role="img" aria-labelledby="np-title np-desc">
<title id="np-title">Load, decode identity, save</title>
<desc id="np-desc">A GLB is decoded; every node gets its identity (authored NodeId or a seed of its authored path) and every stored reference is migrated once through the file's authored index to an address. At runtime references resolve by address, waiting for placements that are not materialised yet. A save writes ids and addresses only and stamps idVersion 1.</desc>
<style>
.rv-d text { font-family: var(--sl-font, system-ui, sans-serif); fill: var(--sl-color-white, #1f2937); font-size: 14px; }
.rv-d .t-title { font-weight: 600; font-size: 15px; }
.rv-d .t-small { font-size: 12.5px; fill: var(--sl-color-gray-3, #4b5563); }
.rv-d .t-mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; fill: var(--sl-color-gray-2, #374151); }
.rv-d .t-accent { fill: var(--sl-color-accent, #b45309); }
.rv-d .box { fill: var(--sl-color-gray-6, #f3f4f6); stroke: var(--sl-color-gray-5, #9ca3af); stroke-width: 1.2; }
.rv-d .box-accent { fill: var(--sl-color-accent-low, #fef3c7); stroke: var(--sl-color-accent, #b45309); stroke-width: 1.4; }
.rv-d .line { fill: none; stroke: var(--sl-color-gray-3, #6b7280); stroke-width: 1.5; }
.rv-d .line-deny { fill: none; stroke: var(--sl-color-gray-4, #9ca3af); stroke-width: 1.3; stroke-dasharray: 4 4; }
.rv-d .head { fill: var(--sl-color-gray-3, #6b7280); }
@media (prefers-color-scheme: dark) {
  .rv-d text { fill: var(--sl-color-white, #f3f4f6); }
  .rv-d .t-small { fill: var(--sl-color-gray-3, #d1d5db); }
  .rv-d .t-mono { fill: var(--sl-color-gray-2, #e5e7eb); }
  .rv-d .t-accent { fill: var(--sl-color-accent, #fbbf24); }
  .rv-d .box { fill: var(--sl-color-gray-6, #1f2937); stroke: var(--sl-color-gray-5, #6b7280); }
  .rv-d .box-accent { fill: var(--sl-color-accent-low, #451a03); stroke: var(--sl-color-accent, #fbbf24); }
  .rv-d .line { stroke: var(--sl-color-gray-3, #9ca3af); }
  .rv-d .head { fill: var(--sl-color-gray-3, #9ca3af); }
}
</style>
<rect class="box" x="0" y="20" width="160" height="104" rx="8"/>
<text class="t-title" x="12" y="44">Load</text>
<text class="t-small" x="12" y="64">GLB bytes: ids where</text>
<text class="t-small" x="12" y="80">written, references as</text>
<text class="t-small" x="12" y="96">path (Unity) or</text>
<text class="t-mono" x="12" y="114">{ address }</text>
<rect class="box-accent" x="196" y="20" width="176" height="104" rx="8"/>
<text class="t-title t-accent" x="208" y="44">Decode identity</text>
<text class="t-small" x="208" y="64">every node: NodeId,</text>
<text class="t-small" x="208" y="80">else seed of its path</text>
<text class="t-small" x="208" y="96">refs migrated ONCE via</text>
<text class="t-small" x="208" y="112">the authored index</text>
<rect class="box" x="408" y="20" width="160" height="104" rx="8"/>
<text class="t-title" x="420" y="44">Runtime</text>
<text class="t-small" x="420" y="64">resolve by address</text>
<text class="t-small" x="420" y="80">late placement: wait</text>
<text class="t-small" x="420" y="96">for its occurrence</text>
<text class="t-mono" x="420" y="114">p/b#id</text>
<rect class="box" x="604" y="20" width="156" height="104" rx="8"/>
<text class="t-title" x="616" y="44">Save</text>
<text class="t-small" x="616" y="64">ids + addresses only</text>
<text class="t-small" x="616" y="80">unresolved: kept as</text>
<text class="t-mono" x="616" y="98">unresolvedPath</text>
<text class="t-mono" x="616" y="114">idVersion: 1</text>
<path class="line" d="M160 72 H188"/><polygon class="head" points="194,72 185,67 185,77"/>
<path class="line" d="M372 72 H400"/><polygon class="head" points="406,72 397,67 397,77"/>
<path class="line" d="M568 72 H596"/><polygon class="head" points="602,72 593,67 593,77"/>
<path class="line-deny" d="M682 124 V170 H80 V130"/><polygon class="head" points="80,126 75,135 85,135"/>
<text class="t-small" x="300" y="164">reload: no migration, the same ids</text>
<text class="t-small" x="12" y="200">input (MCP, UI, URL, plugin) is a PATH → findNodeForUser → stored as the ADDRESS of the node it found</text>
<text class="t-small" x="12" y="220">output shows path / name, carries the address</text>
</svg>
</figure>

**Load (migration, once).** `createMigrationContext` / `migratePath` read a stored PATH through
the file's own AUTHORED index (the names as written, before dedup): as written, then relative to
the content root, then root-stripped. That is the whole chain — no suffix, sanitize or
name-in-scope guessing for stored references. A path that names two nodes is
`reference-ambiguous` and stays unresolved; a legacy Three.js spelling that only the old
resolver accepted is `reference-legacy-spelling`; a target that the bake replaced by a synthetic
node is `reference-target-synthetic`. The migrated address is what every reader uses
(`NodeRegistry.readStoredRef` / `resolveRef` / `resolve`).

**Runtime (late targets).** A reference into a placement that is not materialised yet resolves
to `pending` (`resolveRef`); `whenResolved` queues it, `layout-content-added` (= the occurrence
registered) retries, and the orphan verdict falls once no placement is pending (`missing`), or
early with `placement-missing` / `placement-cap` / `unloaded`. `resolveComponentRefs` uses this for
scalar component references and runs the component's `reapplyConfig()` when the target arrives.
LogicSteps take no such queue: a step resolves once, when it is built, so the main model's steps
are built only once its scene is complete — after its placements materialised, through
`mergePlacedLogic`, the function every placement uses (plan-769 Phase 6, D20; the moment is in
[doc-lifecycle.md](doc-lifecycle.md) § 3.1). A `LogicStep_DriveTo` addressed `<p>#<id>` or
`<p>/<b>#<id>` into placed content therefore holds the placed drive. A placement removed or
replaced later is not re-bound (D21): such a step points nowhere until the next load.

**Save.** The writers (`rv-reference-writer.ts` for the editor export, `stampJsonIdentity` in
[`rv-json-identity.ts`](src/core/engine/rv-json-identity.ts) for the planner save) write the
node's id and every reference as its address; a reference that was bound only by a guess is
`reference-saved-from-guess`, one whose target is not part of the file is
`reference-target-unsaved`. The file is stamped `idVersion: 1`.

**Input.** `NodeRegistry.findNodeForUser(path)` is THE resolver for a path somebody types: the
runtime registry path exactly → the AUTHORED path in the file it lies in → the exact legacy
Three.js spelling → (until plan-770) the registry's guessing stages with a console warning
(`via: 'guess'`). The MCP bridge normalises every path argument through it
(`rv-mcp-user-paths.ts`); tool output shows the path and carries the address.

**Unity (F20).** Unity reads paths only. A GLB saved by the web (`idVersion: 1`) stores addresses
and cannot be imported into Unity; Unity keeps exporting paths, which the viewer migrates on load.

---

## 1. Where node paths appear

The rv-ODT schema defines the carrier type once, as `ComponentReference`. Its PATH form — the
one Unity writes and every pre-769 file carries — is:

```json
"ComponentReference": {
  "properties": {
    "type": { "const": "ComponentReference" },
    "path": { "type": "string", "minLength": 1 },
    "componentType": { "type": "string" }
  }
}
```

Every drive signal, sensor reference, kinematic body and logic-step target in `rv_extras` uses
this shape. A second, implicit use is the `path` field written next to each serialized
component, which records where the component itself lives.

The schema's `path` description is the **normative** definition and answers five questions this
document then explains in prose:

1. **Root inclusion** — the path is absolute and starts at the exported scene root node, whose
   own name is the first segment. A reference to the root is that bare name; a reference to a
   same-named direct child is `X/X`. The glTF `scene` object itself contributes no segment.
2. **Separator** — `/`. Producers must not emit a node name containing `/`.
3. **Which name** — the glTF name as written in the file (`nodes[i].name`), *before* any
   consumer-side sanitization or dedup suffix (section 2).
4. **Uniqueness** — producers should keep names unique file-wide and warn when they are not.
5. **Consumer fallbacks** — permitted, in a fixed order, and never allowed to guess between two
   candidates (section 4).

The schema was written so a stable node id could sit **beside** `path` additively, and since
plan-769 that is exactly what a web save writes: `{ address }` instead of `{ path }` (§0.3).
The path rules above stay normative for every producer that writes paths (Unity) and for the
migration that reads them.

**`NodeId`** (plan-397, rv-ODT specification §5a) is a plain string directly under
`extras.realvirtual` — not a component object:

- A file **we write** keeps every node's id on every later save (a seed becomes the authored id
  on the first save, §0.1). Regenerating ids would orphan every reference and override written
  against the file.
- A file **we only read** — every Unity export, every library asset that must stay
  byte-identical — gets **seeds**: a UUIDv5 of the node's canonical authored path, so the same
  file yields the same ids in every session without anything being written. (Until plan-769
  composition derived `first 16 hex of SHA-256(<file sha256> ':' <node index>)` instead; that
  derivation was removed, F12.)
- `NodeId` is unique **within its file**, never globally. Reference one asset ten times and all
  ten subtrees carry the same ids. The full address is therefore the pair
  `(occurrence, NodeId)`, where the occurrence is the chain of the reference nodes' ids above
  the node — computed while composing / placing, never written into a file.
- The id carries **no `_` prefix**, deliberately: `sanitizeUserDataForExport` strips
  `_`-prefixed keys as runtime bookkeeping, and an id that does not survive an export is worse
  than none. (The SEED lives under `_rvNodeId` exactly because it must not be written until a
  save adopts it.)

Implementation: [`rv-node-id.ts`](src/core/engine/rv-node-id.ts),
[`rv-decode-identity.ts`](src/core/engine/rv-decode-identity.ts); the composite runtime index
lives in `NodeRegistry` (`registerNodeId` / `getNodeByAddress`).

**Overrides carry component values only.** plan-444's transform block `trsByNodeId` was removed
by plan-769 (F14): a part inside placed content cannot be moved, an old file's moves are reported
(`override-transforms-dropped`) and dropped on the next save. See
[doc-persistence.md](doc-persistence.md) §2.0-0a.

### 1a. The occurrence chain is also the breadcrumb address

`childOccurrence(parent, referenceNodeId)` appends one reference node's id per
level, `fullNodeAddress` joins the pair as `<occurrence>#<nodeId>`, and
`parseNodeAddress` splits it again at the **last** separator. `ROOT_OCCURRENCE`
is the empty string, so a node in the file you actually opened has the address
`#<nodeId>` and `occurrenceDepth` 0.

Because a reference node lives in exactly one file, where its id *is* unique,
the chain is globally unique without any file knowing where it is installed.
That single property is why the same chain carries three jobs:

| Job | Who reads it |
|---|---|
| **Address** of a node inside a referenced subtree | `NodeRegistry.getNodeByAddress`; the override router when a field edit inside a reference is written to the outermost reference node's `AssetOverrides.byAddress` (key relative to that asset, `<b>#<id>` for nested content) |
| **Breadcrumb** of the document stack — descending into a referenced asset pushes a frame whose occurrence is the parent's plus the reference node id | `RvDocumentStack.breadcrumb()`, which is literally `occurrenceSegments(occurrence)`; the chain is asserted to stay a prefix chain on every push |
| **Draft key**, as `<projectId>:<rootDocumentId>:<occurrence>` with each segment percent-encoded | `rv-document-drafts.ts` |

The draft key is namespaced rather than being the bare chain for two reasons
that neither the chain nor IndexedDB can fix on its own: reference node ids are
persisted UUIDs *inside* the GLB, so copying a project folder yields two copies
with byte-identical chains; and IndexedDB is scoped to the origin, not to the
project. A bare chain would therefore not merely risk an overwrite — a descend
in project B could load project A's draft and present it as the open document.

Two things the chain is **not**: it is never written into a file (it is a
property of *where an asset is installed*, which the asset itself must not
know), and it is not a node path — `/` separates reference-node ids here, not
node names. See [doc-persistence.md](doc-persistence.md) §2.1b.

`componentType` decides how `NodeRegistry.resolve()` interprets the path — as a Drive, a
Sensor, a signal address, or (for `UnityEngine.Transform` and for legacy entries with no
`componentType` at all) as a plain scene node.

### 1a. The model root is visible — and that changes no path

Since plan-715 the loaded model's root (`viewer.currentModelRoot`) is the **top row of the
hierarchy panel** and the default start node of `web_node_tree`, instead of being folded away.
This is a presentation and addressing change only. **No path moved.** The root was always
registered under its bare name and was always the first segment of every child path (rule 1
above); making it visible only surfaced the row that already existed in the path space.

Two consequences worth stating explicitly, because they are what keeps rule 1 true:

- **The root's `Object3D.name` is never renamed.** The hierarchy shows the *document* name
  (`sceneSnap.draft.name`, falling back to the GLB file name), which is a display label in the
  same sense as the snap and LayoutObject labels — the node keeps its own name, so the first
  segment of every stored reference keeps resolving. `AssetDocument.renameNode` refuses the root
  outright for the same reason.
- **The root is structurally frozen.** Rename, transform, delete, reparent and visibility are
  all rejected centrally (`isModelRoot`, `src/core/engine/rv-model-root.ts`), in
  `AssetDocument` rather than per caller, so MCP tools and UI actions inherit the rule. The
  op-log REPLAY path is the one exception: it *skips* a historical root op with a warning
  instead of throwing, because crash recovery must never fail on a draft written before the
  guards existed.

Root-level `userData.realvirtual` round-trips through `scenes[0].extras` (the only round-trip
capable place for file-level data in glTF), which is what makes the root usable as the anchor
for asset metadata.

---

## 2. The three naming layers

A single node carries up to three different names on its way to the browser. Confusing them is
the root cause of most path problems.

| Layer | Name source | Who sets it | Notes |
|-------|-------------|-------------|-------|
| **Unity name** | `GameObject.name` | The author, or the CAD importer | May contain spaces, dots, colons, and non-ASCII characters. Duplicates in different branches are normal and legitimate — a CAD assembly reused twice produces them by design. |
| **glTF name** | `node.name` in the GLB | UnityGLTF exporter | Normally identical to the Unity name. This is the name the exporter's paths are built from. |
| **Three.js name** | `Object3D.name` after loading | `GLTFLoader` | **Rewritten twice**: first sanitized, then deduplicated. |

Three.js rewrites names in `GLTFParser.createUniqueName`:

1. **Sanitization** — `PropertyBinding.sanitizeNodeName` replaces whitespace with `_` and strips
   characters reserved by the animation binding syntax.
2. **Deduplication** — the parser keeps a **file-global** `nodeNamesUsed` map. The second node
   sanitizing to an already-used name becomes `<name>_1`, the third `<name>_2`, and so on.

Deduplication is file-global, not sibling-scoped. Two nodes named `Pusher` in *completely
different branches* still collide: one of them becomes `Pusher_1`. This is not configurable —
Three.js needs unique names because `PropertyBinding` targets animation tracks by name.

realvirtual mirrors both steps in [`rv-three-names.ts`](src/core/engine/rv-three-names.ts):
`sanitizeLikeThree()` reproduces step 1, and `isPureSanitization()` decides whether a current
name differs from the original by sanitization *only*. When it does, the loader restores the
original name — that case is safe because a pure sanitization implies the name was unique.
When a real `_N` dedup suffix is present, the name **cannot** be restored without reintroducing
a clash, so the node keeps its rewritten name and gets an alias path instead (section 4).

**Sanitization and deduplication are independent, and a node can suffer both.** This is the
distinction that matters most in practice and the one that is easiest to lose:

| Raw glTF name | Sanitized | Collides? | `Object3D.name` | Reachable under the raw name via |
|---|---|---|---|---|
| `Pusher` | `Pusher` | no | `Pusher` | nothing needed |
| `MC04.01I00W` | `MC0401I00W` | no | `MC04.01I00W` (restored) | the restore |
| `Pusher` | `Pusher` | yes | `Pusher_1` | the alias (raw == sanitized) |
| `-Kettenrad 201:1` | `-Kettenrad_2011` | yes | `-Kettenrad_2011_1` | **the alias — and only if the alias carries the RAW spelling** |

The last row is the case that broke: `detectRenamedNodes()` used to record the *sanitized*
spelling for a deduplicated node, so the reconstructed alias read
`-Kettenrad_2011` where the GLB had written `-Kettenrad 201:1`, and the authored path resolved
to nothing. It now records the raw name and `registerNodeAliases()` publishes **both**
spellings (plan-734).

### What a save writes (plan-765)

The rewrite above is a load-side fact; a file must never inherit it. The asset editor's save
([`exportAssetGlb()`](src/core/editor/rv-asset-glb-export.ts)) clones the live tree and, after
both prunes and before the userData sanitizer, writes every node under its **authored** name
again (`restoreAuthoredNames()`): `userData._rvOrigName` — the stamp `detectRenamedNodes()` left
on a real dedup — is the write-side source, and `node.name` is only used where no stamp exists.
A file saved by the editor is therefore in the **Unity name space**: `NL6:501` twice, never
`NL6501` + `NL6501_1`, exactly as the Unity exporter wrote it, and the stored references —
which were always in the authored spelling — resolve against it on the next load through the
same aliases as before. GLTFExporter writes `Object3D.name` verbatim; duplicate names are legal
glTF.

Two edits own the stamp. A **rename** in the editor deletes it (the user's name wins; undo
restores it from the op's `prevOrigName`). A reference **written** in the editor — the picker,
the ribbon rollers, the IK target plugin, a reference-typed `setField` that pins exactly one node
— is spelled from authored names too (`authoredAssetRelativePath()` in
`src/core/hmi/rv-reference-field.ts`), so new references and old ones share one spelling.

The save also measures what the serialization lost — the `save-reference-loss` guard, § 10.4.

---

## 3. How the exporter builds paths

`SerializationContext.GetRelativePath()`
(GLBComponentSerializer.cs:164 (optional Unity Professional source; not included in Community))
walks from the target up to its export root, joining Unity names with `/`.

The export root name is **always** the first path segment, independent of how many roots are
being exported:

| Export | Root | Direct child | Grandchild |
|--------|------|--------------|------------|
| One export root | `X` | `X/Y` | `X/Y/Z` |
| Several export roots | `X` | `X/Y` | `X/Y/Z` |

This matches the schema definition in section 1 ("path from the scene root"), so a root named
`X` with a direct child also named `X` produces the two distinct strings `X` and `X/X`.

> **History.** Until plan-381 the root name was omitted whenever exactly one root was exported
> (child `Y`, grandchild `Y/Z`). A root `X` and its same-named child then shared the string
> `X`, the pre-export gate saw a duplicate path where none existed and offered to rename the
> objects to `X_rv1` / `X_rv2` — which the CAD pattern "container node plus identically named
> assembly node below it" triggered systematically — and the same collision was written into
> the GLB. GLBs exported before that change still carry the old, root-less child paths; the
> viewer resolves them through the suffix fallback (section 4, step 4) as a courtesy, not as a
> guarantee.

Export roots are normalized before anything else runs: nulls, duplicates and any root nested
inside another selected root are removed (`SerializationContext.NormalizeExportRoots`). Export,
ambiguity scan and export warnings all see that same list, so selecting a parent *and* one of
its children no longer traverses the child subtree twice.

There is a second, **decommissioned** copy of this logic in `realvirtualExportPlugin.cs` (the
legacy "realvirtualExport" plugin). Its `CreateInstance` returns `null`, so it never writes
`node.Extras` alongside v2 — it used to be a competing writer in the direct UnityGLTF standard
export, where the outcome depended on plugin invocation order. That direct export path is not a
supported realvirtual export path.

---

## 4. How realvirtual resolves paths

> **Since plan-769 a STORED path reference is migrated once on load** through the file's
> authored index (§0.4) and read as an address. The fallback stages below serve INPUT
> (`findNodeForUser`, with a warning) and, only where that migration yields no node, the
> component binding in `resolve()` — a guessed binding a save reports
> (`reference-saved-from-guess`) instead of storing it. Removing the stages for good is plan-770.

[`NodeRegistry`](src/core/engine/rv-node-registry.ts) holds nine maps. The
first five drive resolution; the last four are indices built on top of them.

| Map | Direction | Contents |
|-----|-----------|----------|
| `nodes` | path → node | Canonical paths **and** alias paths |
| `nodePaths` | node → path | Canonical path only — this is the reverse lookup |
| `components` | path → type → instance | Keyed by canonical path only |
| `suffixMap` | last segment → paths | Index for the suffix fallback |
| `aliasPaths` | node → alias paths | Lets `unregisterSubtree()` take aliases down with the node |
| `prefixAliases` | authored path of a re-parented subtree → moved node | One entry per node the `Kinematic` pre-bake hook moved (asset alias table entries with `subtree: true`, registered by the place step via `registerPrefixAlias`). A path *into* the moved subtree resolves under the node's new place — see stage 1 below. Never registered by an editor move |
| `typeIndex` | component type → set of paths | Reverse index behind `getAll(type)` |
| `reverseRefs` | canonical target path → `{sourcePath, fieldName, componentType, index?}[]` | "Who points at this node?" — indexes `ComponentReference` **objects**, scalar fields and array elements (`index`). Each reference is keyed by the node it resolves to with its authoring scope, so `Mount/Kine` and `Machine/Mount/Kine` land on one key; only a reference that resolves nowhere is keyed by its raw path. Built lazily on the first `getReferencesTo()`; invalidated by `recomputePathsForSubtrees()` and at the end of every reference-rewrite composite (section 10) |
| `signalNameIndex` | signal name → consumers | Signal bindings are loose **strings** (`WebSensor.SignalBool = "MC07…"`), so `reverseRefs` never finds them. Built lazily on the first `getComponentsForSignal()`; invalidated by `clear()` / `recomputePathsForSubtrees()` |
| `gltfNodeIndices` | node → glTF `nodes[]` index | The `associations`-derived map handed over at load time (`setGltfNodeIndices`). The root file's map comes from `setGltfNodeIndices`; references grafted by a composing (authoring) load add **one map per source file** via `addGltfNodeSource(sourceKey, …)`, so a writer never patches `nodes[7]` of the root file with the entry of a referenced file. Op-created nodes and `parseGlbSubtree` results have no entry. A companion `gltfNodeNames` array lets a re-fetching writer prove the bytes match the indices |

Resolution proceeds in this order, in both `getNode()` and `getByPath()`:

1. **Exact match** on the given path.
   - **Prefix alias** (plan-610 Phase 5c), on an exact miss — the longest proper prefix of the query that is the
   authored path of a load-time re-parented node names that node; the rest is looked up under
   the node's *current* path, exactly (canonical or alias entries, a further prefix alias for a
   moved node inside the moved subtree — chain bounded at 16). No suffix or name matching below
   the prefix, and a node registered at the authored path later owns its children (the prefix
   falls silent). Reported as stage `alias`, so the reference audit counts it as regular.
2. **Space-normalized match** — the query with spaces replaced by `_`, mirroring Three.js
   sanitization.
3. **Alias-aware retry** (`getByPath` only) — resolve the node through the node lookup, then
   look the component up under that node's canonical path. This is what lets a reference
   authored before a re-parent still find its target.
4. **Unique suffix match** — any registered path ending in `/<query>`.
5. **Sanitize-normalized full-path match** — the query and every registered path are run
   through `sanitizeLikeThree()`; a unique hit resolves. See below.
6. **Scoped name match** (`resolve()` only, when a scope is passed) — the first descendant of
   the scope whose *name* equals the query's last segment and which carries the requested
   component type.

Step 4 is the reason old, root-less paths still resolve after the exporter starts prefixing the
root name: `Y/Z` is a suffix of `X/Y/Z`.

**Step 4 never guesses.** All candidates are collected; the lookup resolves only when they
denote a single target, and otherwise warns and returns `null`:

```
[NodeRegistry] Ambiguous suffix match for "PartA/Signal": 2 candidates
("CellA/PartA/Signal", "CellB/PartA/Signal") — refusing to guess.
```

"Single target" is measured over the **thing being returned**, not over path strings — an alias
and its canonical path both match but denote one node, and in `getByPath()` only candidates that
actually carry the requested component type compete. The internal probe in step 3 is silent,
because an ambiguous *node* there is not yet a failed *component* lookup.

### Step 5 — the sanitize-normalized last resort

Aliases fix models loaded by a viewer that knows about them. They do nothing for a GLB that was
delivered and is being opened by a build whose alias registration wrote the wrong spelling, and
for a customer model there is often no re-delivery coming. Step 5 closes that gap without a
re-export: `sanitizeLikeThree()` is the one transform that maps the authored spelling and the
loader-assigned spelling onto the same key, so an index over
`sanitizeLikeThree(registeredPath)` finds the node from either side.

Three rules keep it from becoming a guessing machine:

- **It runs only after step 4 found *nothing*.** A step-4 *refusal* — several distinct
  candidates, "refusing to guess" — returns immediately and is never revisited. A refusal is a
  decision, not a miss.
- **It has its own ambiguity refusal.** Sanitization *removes* `[ ] . : /` rather than replacing
  them, so `A.B` and `A:B` both become `AB`. A key claimed by more than one distinct node
  resolves to `null` with one warning per key, never to "the first one".
- **Its index is maintained incrementally and never rebuilt.** It is built once, lazily, on the
  first lookup that reaches step 5 — a model whose paths all resolve exactly never pays for it —
  and after that `registerNode()` / `registerAlias()` add a key and
  `unregisterSubtree()` / `recomputePathsForSubtrees()` remove one. A dirty-flag-plus-rebuild
  scheme would be a trap here: `MuReconciler.reconcile()` registers and unregisters nodes on
  **every frame** while the layout planner runs, so the index would be discarded several times a
  second and each following miss would pay an O(nodes) rebuild.
  `NodeRegistry.sanitizedIndexBuildCount()` exposes the counter; anything above 1 in a running
  session means a rebuild was reintroduced.

One consequence worth knowing: a path that step 5 rescues no longer looks "missing" to code that
uses `getNode(...) === null` as an existence test — `orphaned-bindings.ts` in particular reports
one fewer orphan. That is the intended trade.

### Aliases for deduplicated nodes

When `GLTFLoader` renames a node, its authored path no longer exists in the scene.
[`detectRenamedNodes()`](src/core/engine/rv-glb-parse.ts) collects those nodes, and
[`registerNodeAliases()`](src/core/engine/rv-scene-loader.ts) registers the **original** path as
an alias pointing at the renamed node. `registerAlias()` writes to `nodes`, `suffixMap` and
`aliasPaths` but deliberately **not** to `nodePaths`, so the canonical reverse lookup stays
truthful. It never overwrites an existing entry.

Five properties matter:

- **Both spellings are registered.** `renamedNodes` carries the **raw** glTF name, so the
  reconstructed path is the one the file authored; the sanitized spelling is derived from it and
  registered as well. Only a name containing whitespace or one of `[ ] . : /` differs at all
  between the two — for every other name the second registration is de-duplicated away and costs
  nothing. Registering both means content exported against the historical (sanitized) spelling
  keeps resolving alongside the authored one.
- **The whole subtree is aliased, not just the renamed node.** Every descendant gets its own
  pre-dedup path, so `Kinematics_MC07/Pusher/vertical` resolves even though only `Pusher` was
  renamed. Without this, the suffix fallback cannot help: it matches whole path suffixes, and
  the break sits in a *middle* segment.
- **One traversal, one visit per node.** The renamed set is first reduced to its topmost
  members, then those subtrees are walked behind a shared visited set — nested renames cannot
  make this quadratic.
- **Placed and individually loaded assets are covered too.** Such a subtree is typically a
  `clone()` of a cached parse result, so the parser's `Object3D`-keyed rename map cannot travel
  with it. `detectRenamedNodes()` therefore also stamps the pre-dedup name into
  `userData._rvOrigName`, which survives cloning; `collectRenamedNodes()` rebuilds the map from
  those stamps and `processExtras()` runs the same aliasing step. The `_` prefix is load-bearing:
  `sanitizeUserDataForExport()` strips exactly those keys, so the marker never reaches a saved
  GLB.
- **Signal aliases are additive.** A node carrying a PLC signal also gets its pre-dedup path
  registered in the `SignalStore` via `registerPathAlias()` — which writes `pathToName` only.
  It deliberately is not `register()`, which would also rewrite `nameToPath` and thereby repoint
  the canonical name → path mapping at a merely historical spelling.

**The export is the counterpart (plan-765).** The stamp is read once more before it is stripped:
the editor's save restores every stamped node's authored name on the export clone, so the file
carries the names the references use and the next load re-derives the same dedup, stamps and
aliases (§ 2, *What a save writes*). The read side is unchanged. One case has no alias to fall
back on: **true sibling duplicates** (`Sep/Pin` twice under one parent) share their authored path,
so no path can tell them apart. The reference picker lists such a path once, disabled, with
"N siblings share this name — not addressable by path; rename one in the source", and never
writes it; a `setField` whose target resolves to such a node keeps the string as given.

Aliases are removed with their subtree: `unregisterSubtree()` consults `aliasPaths` and drops
each alias from `nodes` and `suffixMap`. Alias spellings are *not* included in the returned
"removed paths" set — downstream purges match that set against canonical paths only.

Debug output makes this visible — load with `?debug=loader,verbose` and look for:

```
N node(s) renamed by Three.js (name dedup)
Aliases registered: 12 node path(s), 3 signal path(s), 0 dropped (path already taken);
  largest suffix bucket "Volumenkörper1" ×3279; 41.2 ms
Node alias: "Kinematics_MC07/Pusher/vertical" → "Kinematics_MC07/Pusher_1/vertical"
```

The same four numbers ride along on `LoadResult.aliasStats` and are shown in DevTools ▸ *Scene
(from GLB)*. **Dropped** is the one to watch: `registerAlias()` correctly refuses to overwrite an
existing registration, but a dropped alias is precisely how a node stops being reachable under
its authored path — and until it was counted, that was completely invisible.

### Checking a GLB before it ships

`npm run audit:instruction-targets -- <model.glb>` resolves every `CustomRuntimeInstruction`
target offline, straight from the glTF JSON chunk, and exits non-zero if any of them is
unreachable. It reports two numbers — how many the *current* viewer cannot resolve (the shipping
gate) and how many a pre-plan-734 viewer could not (the blast radius of the alias bug in that
particular model) — plus, for a broken target, which path segment Three.js both deduplicated and
sanitized. `auditGlb()` is exported for callers that would rather not parse stdout.

---

## 5. Known pitfalls

### 5.1 A path is not an identity

Everything below follows from this. A node path is only as stable as every name along it, and
nothing in glTF guarantees those names. Renaming a node in Unity invalidates every stored
reference leading through it, and no amount of fallback logic can recover the intent.

Inside realvirtual WEB this is handled at both ends since plan-610: a rename or move in the
asset editor, the MCP editor tools or the Node GLB scripts rewrites the stored references of
the open document in the same step, and the load audit reports every reference that no longer
resolves, or resolves only by a fallback, in the Problems panel (section 10). Neither reaches
other documents or the Unity source.

### 5.2 A name collision anywhere in the file breaks paths through that node

Three.js deduplicates **file-globally**, so two nodes named `Pusher` in unrelated branches are
enough. The viewer now aliases the whole renamed subtree (section 4), which repairs *resolution*
— but the underlying scene still contains a node whose name is not what the author wrote, and
the aliases are best-effort reconstruction, not a contract. Keeping names unique across the
export remains the actual fix (section 8).

Sanitization runs before deduplication, so names that differ only in characters the sanitizer
touches collide as well: `A B` and `A_B` both become `A_B`.

### 5.3 The export *gate* does not catch that collision — a separate warning does

The pre-export gate compares complete paths, not names — see section 6. `MC06/Pusher` and
`MC07/Pusher` are distinct paths, so the gate reports nothing, while Three.js will nevertheless
rename the bare name `Pusher`.

Since plan-381 the export emits a **separate warning** for it after writing the file, listing
every reference target that sits below a node whose *sanitized* name is not unique. Names are
compared after Three.js sanitization, so `A B` and `A_B` count as the same name. Nothing is
renamed — repeated names in different branches are normal for CAD assemblies:

```
3 referenced target(s) sit below a node whose glTF name is not unique
in this export. Three.js renames duplicate node names when loading the GLB
(Pusher -> Pusher_1), which breaks paths to their children in realvirtual WEB.
Names are compared AFTER Three.js sanitization, so "A B" and "A_B" collide too.
Rename the colliding nodes in Unity, then re-export.

  - Kinematics_MC07/Pusher/vertical      (ancestor "Pusher" occurs 2x)
```

### 5.3b An instruction target is resolved once, at load

`RVCustomRuntimeInstruction` resolves its step targets in `onSceneReady()` — the first moment
the registry is final, after alias registration and after kinematic re-parenting has recomputed
the paths it moves. Whatever does not resolve there is marked on the step
(`InstructionStep.unresolvedTargetPaths`), shown on the card and reported to the Problems panel
as `unresolved-instruction-target`.

The resolution is **not** repeated. If the layout planner places the missing asset *after* the
load, the step stays marked for the life of that component instance. This is a deliberate
non-goal, not an oversight: a model switch runs `init()` + `onSceneReady()` afresh and gets it
right there, and re-resolving on every scene mutation would put a registry lookup per target on
a path that mutates every frame.

### 5.4 An unresolved signal reference still returns the raw path

When no lookup resolves a signal reference, `resolve()` returns `ref.path` unchanged. That is
deliberate — the `SignalStore` runs its own normalization, and a pure process-image signal
legitimately has no scene node at all — but it means a genuinely broken reference produces a
component bound to an address nobody writes. It is no longer silent:

```
[NodeRegistry] Signal node not found: "Kinematics_MC07/Pusher/vertical" —
falling back to the raw path; the signal may not be driven.
```

The wording is deliberately non-committal: the raw path *may* still resolve downstream. Treat
the warning as "look here first", not as proof of a defect.

### 5.5 Resolved earlier, kept here as history

These were live defects until plan-381 (Phase 3) and are fixed; the notes remain because
existing GLBs and older debug transcripts still show their symptoms.

| Was | Now |
|-----|-----|
| Only the renamed node itself got an alias; descendants did not resolve | The whole subtree is aliased |
| Aliasing ran on the `loadGLB` path only; placed assets stayed broken | `processExtras()` aliases too, from `userData._rvOrigName` stamps |
| An ambiguous suffix match returned whichever candidate was registered first | The lookup warns and returns `null` |
| Aliases survived `unregisterSubtree()` and pointed at detached objects | Aliases are tracked per node and removed with it |
| Signal aliases went through `register()` and hijacked `nameToPath` | Additive `registerPathAlias()` leaves the canonical mapping alone |

---

## 6. What the export gate does and does not catch

`AmbiguousReferenceNameFixer` runs before every export (gated by
`AssetManagerSettings.checkAmbiguousReferenceNames`) and reports **referenced targets whose
complete exported path occurs more than once**. Repeated individual segments in different
branches are explicitly allowed — that is deliberate, because CAD assemblies produce them
constantly.

The gate alone is blind to exactly the case in 5.2: `MC06/Pusher` and `MC07/Pusher` are
distinct complete paths, so the gate reports nothing, while Three.js will nevertheless
deduplicate the bare name `Pusher` and break the descendant paths. That case is covered by the
separate post-export name-collision warning described in 5.3 — a warning only, never a rename.

Renames performed by the gate are by object, so Unity references survive; the suffix pattern is
`_rv1`, `_rv2`, and so on. Downstream consumers that match on part numbers strip it —
`ExcelMetadataSetup.Stem()` removes a trailing `_rvN` before comparing. Existing `_rvN` names
from before plan-381 stay as they are; the fix only stops new ones from appearing.

---

## 7. Resolution on re-import into Unity

`GLBTransformUtilities.FindChildByRelativePath()` resolves a stored path back to a `Transform`
in three steps: a direct `Find()`, a retry with the root name prefix stripped, and a recursive
search that tries both with and without the root prefix. It therefore accepts paths written with
or without a leading root name, which is why the Unity import side was unaffected by the format
change in section 3 and still reads GLBs exported before it.

**A GLB saved by the web cannot be imported into Unity (plan-769 F20).** Unity reads the PATH
form only; a web save (`idVersion: 1`) stores references as addresses and path fields as
`{ address }` records. The direction that keeps working is Unity → web: Unity keeps exporting
paths, and the viewer migrates them on load (§0.4).

---

## 8. Practical guidance

- **Keep names unique across the whole export, not just among siblings.** Three.js deduplicates
  file-globally. If two nodes anywhere in the file sanitize to the same name, one gets renamed.
- **Remember that sanitization happens before deduplication.** `A B` and `A_B` are distinct in
  Unity but identical after sanitization, so they collide in the browser.
- **Prefer renaming ancestors over leaves.** A collision on a node with children breaks every
  reference below it; a collision on a leaf breaks only references to that leaf.
- **When a signal does not move, check the loader debug output first.** `?debug=loader,verbose`
  and a `Node alias:` line mentioning your node is the fastest confirmation that a dedup rename
  is involved.
- **Do not treat a path as an identity.** Renaming a node in Unity invalidates every stored path
  through it (in the WEB editor and the GLB scripts the open document is rewritten for you —
  section 10). glTF has no standard for stable node identity
  ([KhronosGroup/glTF#2337](https://github.com/KhronosGroup/glTF/issues/2337) is still open);
  Three.js offers `gltf.parser.associations` as an official route back to the original node
  index, which is the direction a future ID-based reference scheme would take.

## 9. Baked models: root + logic nodes only (plan-753 / plan-754)

DES component IDs build on this node address: `desComponentId` in `src/core/material-flow/rv-des-identity.ts` appends the component type; see [DES snapshots](doc-des-snapshot.md).

Since plan-753 Phase 3 a **layout-planner placement is an instance of a baked library asset**:
the placement root (`LayoutObject`) carries a handful of *chunk meshes* (one merged geometry per
mover × material bucket, shared by every placement of the same asset) plus the asset's **logic
nodes** — the nodes that carry a component (`Drive`, `TransportSurface`, `Sensor`, `Lamp`, …),
a `Snap-*` port or a mover role. The CAD hierarchy of the library file is **not** rebuilt under
the placement; its triangles live inside the chunks.

**Since plan-754 the same is true of the MAIN model.** The bake is destructive: the GLB is parsed
into a temporary graph, and the model that reaches the scene is a fresh *template* holding the
survivors only — component nodes (a `Group` or an export marker alone does not count, see below),
reference targets, `Snap-*` ports, their ancestors, keep meshes, the chunk meshes and the
partition objects the bake creates for groups. Everything else is not hidden, not masked and not ghosted: it does not
exist, and it is never registered. So this section is no longer about placements; it is the
runtime rule for every baked model.

> **Registered = document.** The `NodeRegistry` is the document's address book, and after the
> bake it holds exactly the template's nodes. A path resolves iff the registry knows it. Anything
> else in the scene — a chunk mesh, a light, a gizmo, a hover overlay, a pooled MU — is visible
> in the hierarchy and in the MCP node tools, flagged `chunk` or `runtime`, and has only a
> *computed* name path: readable and measurable, never a reference target and never selectable.

Consequences for node paths:

- **Addressable paths inside a baked model are the root and its logic nodes**, e.g.
  `Conveyor_2/Transport-Z` or `Conveyor_2/Drive-Rot-Y`. A CAD sub-path such as
  `Conveyor_2/Frame/Leg_3` **does not exist any more** and yields no hit in `web_node_find`,
  `web_node_tree`, `web_node_bounds` or `web_select`. Skills that used to address CAD parts
  (`weblayout`, `webmcp`, `debugweb`) address the model root, a placement root or a logic node.
- A bare CAD node that a plugin or an integration must still reach at runtime has to be
  **claimed** before the bake — see `RVPlugin.bakeClaims` in `doc-extending-webviewer.md`, or
  author a component / an `rv.BakeRole` on the node in the GLB. An unclaimed node is removed.
- **A `Group` alone claims nothing (plan-755).** Component types that declare the capability
  `claimsNode: false` — `Group` (incl. `Group_1`, …) and the Unity export markers `rigidbody`,
  `renderer`, `colliders`, `BoxCollider`, `MeshCollider`, `RuntimeUIWindow`,
  `RuntimeInteractable` — do not keep their node alive. A node that carries nothing else survives
  only as reference target, plugin claim, `Snap-*` port, keep mesh or ancestor of a survivor. On a
  CAD model grouped down to single solids this is a large, deliberate break: about **12,600 node
  paths of the large CAD line that resolved before no longer resolve** (group-only nodes plus the plain
  ancestors only they kept alive). Saved paths and MCP scripts that named such a node must switch
  to one of: the group's **partition object** (next item), a `bakeClaims()` claim, a real
  component on the node, or the editor (which never bakes).
- **Partition objects: `<boundary>/<key>`.** Inside a chunk boundary the bake splits the geometry
  by the set of group names between a mesh and that boundary and creates ONE node per
  combination, which is the parent of those chunk meshes and a registered member of each of its
  groups (hide / isolate in the Groups panel act on it). Its path is `<boundary path>/<key>`;
  **static group geometry hangs directly under the model root: `<root>/<key>`**, not under the
  nearest surviving ancestor. `<key>` is the sorted group names joined with `|`, used as the node
  name as-is (`MC01.13`, `CNCCase|CNCDoor`); only `/` is removed, and a sibling name collision
  gets the usual `_N` suffix with the readable spelling in `userData._rvOrigName`. Members that
  a `Kinematic` integrates are re-parented before the bake, so their object sits under the
  kinematic: `<Kinematic>/<GroupName>`. A group that sits ON the boundary node creates no object
  — the boundary node itself is the member.
  A partition object is **synthetic** (`userData._rvSynthetic`): it is registered, resolvable by
  its real path and selectable in the hierarchy, but it exists in no document — read-only in the
  inspector, never an override or reference target you persist, and **excluded from the
  sanitized-path fallback** (stage 4 of the resolver): it was never an authored path, and its
  free-text name must not make an authored path ambiguous.
  Since plan-757 a planner placement gets the same partition objects as the main model: the
  `ModelCache` bakes through the one recipe (`prepareAndBake`, `src/core/engine/rv-prepare-and-bake.ts`),
  hooks included, and `instantiate()` clones the whole template — so a placement has the same
  nodes, aliases and partition objects as the document that opens the same file, at another root
  (plugin `bakeClaims()` stay main-model only, see `doc-extending-webviewer.md`). Its groups are
  merged by NAME into the viewer's `GroupRegistry` (Unity semantics: ten placements with a group
  `Platen` are one group with ten member sets) and leave it again when the placement is removed.
- **Component references are asset-relative (plan-757 D12 / F7).** The editor writes a
  `ComponentReference.path` RELATIVE TO THE ASSET ROOT (`Mount/Kine`, no root segment). Files
  exported by Unity spell the root (`Machine/Mount/Kine`); both are read by ONE resolver
  (`src/core/engine/rv-reference-resolver.ts`, used by `prepare` before the bake and by
  `NodeRegistry.resolve()` at runtime) in exactly this order:
  1. the path as written, inside the asset scope (`<asset root path>/<path>`, with the registry's
     alias and sanitized stages);
  2. else, if the first segment equals the asset root's authored or current name, strip it and
     resolve the rest inside the scope;
  3. else unresolved — reported (`override-orphaned`, the removal report, a console warning),
     never guessed and never resolved into ANOTHER placement.
  The order makes a real child named like the root unambiguous: `Conveyor/Conveyor/Belt` resolves in
  step 1 through the renamed-node alias of the `Conveyor_1` child before step 2 could strip the
  segment and land on the root's own `Belt`. The scope is the enclosing asset root — the main
  model root, or the placement's reference node, whose registered names include the asset's own
  root name (`Arburg_1` places `Arburg` — the placement's `_N` name is the planner's
  sibling-unique name, see the placement-naming rule in the reference paragraph below, and
  `_originalName` on the root still holds the asset's own name), so `Arburg/Kine` binds inside
  each of ten Arburgs.
  A legacy `AssetOverrides.byPath` key (pre-769 files) is read the same way, relative to the
  reference node, and migrated to its address when it resolves (doc-persistence §2.0-0a).
- Chunk meshes appear as plain meshes named after their chunk key (`static`,
  `mover:<path>`, `tex:<material>`, with a `grp:<key>` segment when partitioned, e.g.
  `mover:<path>|grp:<key>|tex:<material>`); they carry no `rv_extras` and are never a reference
  target. The key is an identity — never parse it by splitting on `|`, a group key contains `|`.
  The hierarchy panel LABELS them "kind + size" (`Merged · 84.2k tris`, `<material> · 12k tris`,
  prefixed `<partition> · `; plan-505) — a display label only, the name is the key.
- **The hierarchy's fold row is presentation, not a node (plan-505).** The panel lists a
  boundary's direct chunk meshes behind one row `Geometry · N chunks · M tris`. That row has no
  `Object3D`, no path and no registry entry; it is not an MCP target (`web_node_tree` and the
  scene snapshot list the chunk meshes themselves, unchanged) and nothing may address it. Its only
  identity is the panel-local expand key `<boundary uuid>::baked`.
- **The asset editor is unaffected.** It never bakes: it opens the document through
  `ModelCache.decodeFresh`, where the full CAD hierarchy and every path of section 4 still exist.
  Per-part addressability of bare CAD nodes is an editor-mode property now.
  An `AssetOverrides.byAddress` entry on a node that is not a logic node has no target after the
  bake and is reported as `override-orphaned` (Decision 1). plan-753 I7's forced chunk split for
  `trsByNodeId` was removed with the field (plan-769 F14): one bake per asset.
- **No runtime rollback of the bake (plan-757 Phase 3, 2026-09-22).** The Visual-tab switch went
  with commit A, the localStorage `rv-webviewer-static-merge` override with commit B (a stored value
  is ignored); the only rollback is a deploy revert. A bake that FAILS is a load error
  (`BakeFailedError`, `bake-failed` problem), never an unbaked tree. Per-part addressability of bare
  CAD nodes is therefore an editor-mode property, full stop. The pick structure keeps a rollback of
  its own (`rv-webviewer-pick-structure` = `0`, the linear segment walk of `PickBackend`) — it
  changes how a chunk is picked, never which nodes exist.
- Persistence is unchanged: a placement is still saved as reference + transform
  (`AssetReference`), never as a copy of the hierarchy (Decision 11).
- **Every reference is a placement, recursively (plan-757 Phase 2, 2026-09-22).** No viewer load
  (`viewer.loadModel` — HMI, planner, the embed facade and, since plan-774, the asset editor)
  grafts: EVERY non-`embedded` `AssetReference`
  node of the document — a planner placement (`PlacementMeta`) or a hand-authored reference —
  stays an empty node, survives the bake (`AssetReference` claims its node) and is materialised
  by the viewer's `PlacementInstancer` through the same `ModelCache` recipe as any placement; a
  reference INSIDE a placed asset is queued by the instancer itself, before the outer placement
  settles (the scene-ready contract holds). The main model is the placement at the origin that is
  not cloned, so a document with geometry of its own AND references bakes like one without.
  `compose()`'s graft is left only for `embedded` references and for direct `loadGLB` calls without
  `deferPlacements` (tests).
  - **The asset editor = nested prefabs (plan-774).** An editor load keeps its OWN content unbaked
    (`preserveHierarchy`, the authoring tree) and defers every reference like the HMI: the
    placements are the session `ModelCache`'s baked instances, shared with any HMI instance of the
    same asset. **Owned content** = nodes of the open document (`isOwnedContent`, i.e. not inside a
    reference); **placed content** = everything under a non-embedded reference node. Inside placed
    content the editor can do what the file can store: a component value edit on a surviving node
    is an instance override — the executor writes it into `AssetOverrides.byAddress` of the
    OUTERMOST reference in the same op (one undo entry; Revert = `unsetField` back to the asset's
    own value, recorded as runtime `_rvOverrideBase`). Structural ops are refused by the reference
    guard, mechanism snap / anchor / face pick and the mechanism commands refuse with "Open that
    asset (double-click the reference) to author its mechanism", and the whole-tree tools (stats,
    heatmap, material stats and presets, select-similar, separate / merge, the editor arenas) see
    owned content only. Descend opens the subasset from its own bytes, unbaked; its own references
    stay baked.
  - **Authoring join.** Every editor load goes through `loadAuthoringModel()`
    (`src/core/editor/rv-authoring-load.ts`): load, wait for `whenSceneReady()` with a budget
    (60 s), then check the document is still the one asked for (else `superseded`, nothing
    replayed). On budget expiry the editor opens with `placements-still-loading`; a replayed op on
    placed content waits for the late settle — a draft's waiting tail is document state (counted
    dirty, part of the draft). `web_editor_open` / `web_editor_status` report `placementsReady`.
  - **Kept bakes.** A load keeps the previous document's baked assets until its own placements
    settle and retires what it did not claim (`ModelCache.releaseDocument({ keepBaked })` +
    `retireKept()`; any load → the next load, an empty GLB ends it). Descend holds the window
    (`holdKept`) until Back to the root, so undo-by-recompose, Back and test-run stop rebake
    nothing (`ModelCache.bakeCount`). A saved document invalidates its cache key on
    `document-saved`, so Back after a descend-save shows the new child.
  - **Problems the editor adds:** `reference-target-baked-away` (an owned reference points at a
    node the subasset's bake dropped — give the part a component inside the subasset),
    `kinematic-member-in-placed-content` (an owned Kinematic integrates a group whose members the
    open document assigned inside placed content), `replay-op-skipped` (a replayed op whose placed
    target is gone or not loaded), `reference-content-discarded` (a legacy file stored children
    under a reference node; they are detached before materialisation).
  - **Paths of nested content** are plain hierarchy paths through the reference nodes:
    `Layout/Machine_1/Cell_1/Slide` for a Cell placed inside a Machine placed in the layout,
    `Machine/Mount/Cell_1/Slide` when the reference sits under a static intermediate node. The
    reference node keeps the name the file gave it; a hand-authored reference is not pivoted
    (its content keeps the child transforms, as the graft did), a planner reference is
    floor-centre pivoted.
  - **A placement has ONE name (plan-758).** The record's `label`, the scene node's name and the
    reference node the save writes are the same string, and the hierarchy path's last segment
    is that string before the save and after the reload. The name comes from ONE helper,
    `src/core/engine/rv-node-naming.ts`, with the WebViewer's `_N` convention counting from 1
    and filling gaps: the first placement of an asset whose GLB root is `Belt` is `Belt`, the
    next `Belt_1`, then `Belt_2`. The taken names are the children of the node the placement
    lands under (the model root) PLUS every planner placement root wherever the document keeps
    it — a reloaded document's placements sit one level below the model root while a live drop
    lands directly under it, and a copy of a reloaded `Belt` must still not be a second `Belt`
    (`placementTakenNames` in `scene-mutations.ts`). The GLB root name wins over the catalog
    label, as before. A copy (`Ctrl+D`,
    `Ctrl+V`) is named by `copyName`: the source's own trailing `_<digits>` block is stripped
    first, then the first free name in that family is taken — ten copies of `Belt_2` read
    `Belt_3` … , never `Belt_2_1` and never the former `Belt (copy) (copy)`. Nothing else
    strips: a fresh placement of a catalog entry called `Conveyor_2000` stays `Conveyor_2000`
    (its copy is `Conveyor`, then `Conveyor_1` — accepted). Every RECORD-driven creation — GLB
    reload, the legacy autosave restore, the undo of a delete and the redo of an add
    (`placeFromRecord`) — applies the recorded name verbatim (`naming: 'keep'`) and never
    re-uniquifies, so a name can never depend on the order in which records are restored.
    A sibling that already carries the recorded name is reported as the Problems entry
    `placement-name-collision` and left alone (the registry then resolves that path to the
    last node registered); a record that reaches the save with an empty name is written under
    the fallback and reported as `placement-name-empty`. Legacy names such as `Belt (copy)`
    are opaque to the strip rule and are never rewritten; a copy of one is `Belt (copy)_1`.
    Two reference nodes with the IDENTICAL name in one file are a pre-existing case the
    loader resolves before any planner code runs (three.js renames the second at parse time,
    §2.1) — the planner cannot keep such a name and does not try.
  - **A nested root is CONTENT of its record's placement, not a record.** It carries
    `userData._layoutObject` + `_layoutNestedOf` (the parent placement's id) +
    `_layoutNestedId` (its stable occurrence chain `<parent id>/<reference NodeId>`, what placed
    behaviors key it by) and never `_layoutId`. Planner tools that need "the record" climb with
    `recordRootOf(node)` (`src/core/engine/rv-placement-instancer.ts`); runtime rules that ask
    "which placement owns this content" use the innermost root (`isPlacementRoot`). The hierarchy
    panel shows it under its placement; it is not selectable or movable as a record of its own.
  - **NodeId addresses:** placed content is indexed under its placement's occurrence — the
    reference node's identity for a document-level placement, the chain `<outer occurrence>/<reference
    id>` for nested content — so `NodeRegistry.getNodeByAddress(nodeId, occurrence)` answers
    for placed content as it did for a grafted frame. Every node has an identity (authored id or
    decode seed, §0.1), so every node is addressable.
  - **Save routing — values at any depth, moves nowhere (plan-769 Phase 4b).** A component edit
    inside placed content routes to `AssetOverrides.byAddress` on the OUTERMOST placement the file
    holds (`locate()` climbs past every nested reference), keyed relative to that placement's asset:
    `#<id>` for its own nodes, `<b>#<id>` for content of its nested reference `b`. plan-757's
    refusal of depth ≥ 2 (`ReferencedFileWriteError` for nested content, the `nested-reference`
    orphan) is gone. A MOVE of any node inside placed content is refused by name —
    `NestedTransformRefusedError` (`nested-transform-refused`) with the path, its placement and the
    way out.
  - **Applying nested overrides.** The instancer resolves a placement's own record and what outer
    placements routed into its occurrence together (`BakeRegistry.applyOverrideLayers` →
    `applyOverrideLayers`, the outer file wins). An override aimed into a nested placement that is
    not materialised yet waits in the instancer's queue (by target occurrence) and applies when it
    is; 404 / cap / refusal flush it as `placement-missing` / `placement-cap` /
    `placement-refused`; the document change empties it; what is left once nothing is pending is
    `override-orphaned` with the reason `missing`. A legacy `byPath` through a nested reference
    node is routed the same way.
  - **Refusals are visible:** a reference cycle (A → B → A, or back to the document) and a depth
    beyond `MAX_REFERENCE_DEPTH` (16) leave the node empty with a labelled placeholder and a
    `reference-cycle` / `reference-depth` problem; the per-load cap (`maxPlacementsPerLoad`,
    5000 by default) stops NESTED queueing with ONE aggregated `placement-cap` entry.
  - **Parametric families (plan-650):** a family document carries `_Parts` (base parts) and
    `_Generated` (the baked variant) below its `ParametricComponent` node. A pre-bake hook removes
    `_Parts` in EVERY bake (main model and placements), so after the bake only the family node and
    whatever `_Generated` claims are addressable — `_Parts/…` paths exist only in the asset editor.
    A placement's variant is chosen by `AssetOverrides.byAddress["#<familyNodeId>"].ParametricComponent.Values`,
    not by a different file; the template under `#param:<inputHash>` is a cache key, never a path.
    Nested families are ordinary nested placements: the empty reference nodes
    `_Generated/_Children/<i>` (NodeId `<familyNodeId>:_Children:<i>` — no `/`, a NodeId is one occurrence segment) materialize as
    `<placementId>/<familyNodeId>:_Children:<i>`; a component field pointing across that boundary
    is refused (`parametric-cross-reference`). Details: [doc-scripting.md](doc-scripting.md)
    § *Parametric part families*.
  - **Sidecars:** an unsigned placed asset gets its own `<glb>.kin.json`, exactly as a composed
    frame did (`ModelCache` applies it before the recipe); a signed asset is self-contained.

## 10. Reference rewrite on rename / move (plan-610)

**Since plan-769 this section applies to PATH-form references only.** A reference stored as an
address (`#<id>`, every web save) names its target by identity, so a rename or move needs no
rewrite at all; the planner skips address-form references. What follows still runs for the
paths a file carries before its first web save, for path-string fields in path form and for the
Node GLB scripts.

Renaming or moving a node changes the canonical path of the node and of its whole subtree. Since
plan-610 every writer of structure rewrites the stored paths that point there **in the same
step**, so a rename or move survives save + reload. One pure module plans the rewrite —
`src/core/engine/rv-node-path-rewrite.mjs` (plain JS, no imports, `planReferenceRewrite`) — and
three entries use it: `AssetDocument.renameNodeAwaited` / `reparentNodesDetailed` /
`reparentNodesBatchDetailed` (and their `void` / path-only wrappers `renameNode`,
`reparentNodes`, `reparentNodesBatch`), hierarchy drag & drop and `groupIntoEmpty` through them,
and the Node GLB scripts through [`scripts/lib/rv-glb-nodes.mjs`](scripts/lib/rv-glb-nodes.mjs).

### 10.1 What is rewritten

| Kind | Where | Rule |
|------|-------|------|
| `ComponentReference` | any field of any component record, at any depth (scalar, array, nested record) | always, when it resolves into the changed subtree |
| `PATH_FIELDS` | `CustomRuntimeInstruction.steps[].targetObjects` / `.targetObject`, `Kinematic.Parent`, `WebPhysicsZone.StaticColliders`, `Connections.connections[].source` / `.target`, `LogicStep_Enable.Target` (plan-769), `RobotIK.TCP` | the same, for raw path strings (also a legacy `{ path }` record or an array of them) |
| `NAME_FIELDS` | `Source.ThisObjectAsMU` | on a **rename** only, and only when the name resolves **uniquely** in the owner's scope; otherwise a `name-field-ambiguous` warning and no write |

Matching is on **segment boundaries**: moving `PLC` rewrites `PLC/FG01/X`, never
`PLC_Programs/…`. Each reference is first resolved against the state **before** the change —
with its component type and the referrer's authoring scope, through
`NodeRegistry.resolveWithStage()`, the same chain as `resolve()` (section 4) that also reports
which stage hit — and only a reference whose target lies in a changed subtree is touched.

- **The spelling is kept.** An asset-relative path stays relative (`Mount/Kine` →
  `Mount/Rig/Kine`), a root-prefixed Unity path stays root-prefixed with the author's own root
  segment.
- **Fallback hits are healed.** A reference that resolved only through `alias`, `space`,
  `suffix`, `sanitized` or `name-in-scope` onto a moved node is written as the exact new path, in
  its spelling — a move does not preserve a fallback. When the new path cannot be expressed in
  the written spelling the reference stays as it is and a `reference-left-scope` warning names it.
- **Several hits in one top-level field become one write** carrying the complete new field
  value (the editor writes top-level keys).
- **Idempotent:** a second run with the same moves over the rewritten state plans nothing.

**Not rewritten, by design:** signal **names** (operator panel, ST programs, `WebSensor` string
bindings — they address signals by name, not by path), `Kinematic.GroupNamePrefix` /
`Group.GroupNamePrefix` (a group-name prefix), `JumpOnSignal.JumpToStep` (a step name),
`AssetOverrides` keys (addresses, unaffected by a rename; a legacy `byPath` key is migrated when
applied), referrers **inside placed / referenced content** (that content
belongs to another file), and **other documents** that point into this one by path — they are
not searchable from the open document. The MCP result says so (`note`), and the load audit
(10.4) makes such a break visible when the other document is opened. Plugins that keep their own
paths in extras are outside the rewrite.

### 10.2 One undo step, deferred re-binding

The structure ops (`renameNode` / `reparentNode`, collision auto-renames included) and the
planned `setField` steps are applied as **one** `composite` op, planned inside the same document
queue slot as its apply. Undo restores every old path byte-identically; redo and draft replay
replay the stored values and recompute nothing. There is no new op kind.

Such a composite is marked (`RvOpMeta.referenceRewrite`, or `referenceRewriteRanges` when it
was flattened into a transaction entry, so unmarked siblings keep their exact order). Inside a
marked range the executor writes extras at once but **defers the whole
`reapplySchemaForComponent`** of each touched component to the end of the range, where it runs
with the node itself as scope — so twin subtrees with asset-relative references keep their own
targets, and an undo does not resolve a reference against a node that still carries the new
name. The flush also re-binds **foreign** referrers whose resolved signal address lay in a
changed subtree (a consumer inside a placed asset below a renamed group); their extras stay
untouched. A flush error rejects the action and rolls it back (nothing recorded); a failed undo
stays on the undo stack, as for any other op. `reverseRefs` is invalidated at the end of every
such composite.

Unmarked composites and `withTransaction` sequences behave exactly as before.

**Two spellings in the rename map (plan-765 F2b).** Stored references are spelled in authored
names (§ 2, *What a save writes*), the registry in the loader's. A rename therefore plans its
rewrite from two maps: `moves` (old → new registry path, current names) and `authoredMoves`
(the same move spelled with `_rvOrigName` for the renamed segment and every stamped ancestor →
the new name). A reference that resolved through an alias and whose written tail equals the
node's authored path is rewritten in the authored spelling — `Gripper_rv3/NL6:501` becomes
`GripperB/NL6:501`, not `GripperB/NL6501_1`. Descendants map by prefix in both maps; still one
composite, one undo step. Moves (reparent without a rename) pass no `authoredMoves` yet.

### 10.3 Refusals

Before anything is mutated, a rename (direct, or the collision auto-rename of a move) is refused
with `RenameRefusedError { reason }` when the name is empty or contains `/`, the node is the
model root, it sits in referenced content, or it is a **signal node whose signal name follows
its node name** (`signalNameFollowsNodeName()` in
[`rv-signal-construction.ts`](src/core/engine/rv-signal-construction.ts): a PLC signal component
with no or an empty `Name`). Renaming such a node would rename the signal under every PLC /
CONNECT binding; the refusal names `web_editor_signal_rename` (or setting `Name` first) as the
way out. A move that would auto-rename such a node is refused as a whole. A signal node with a
non-empty `Name` renames normally — its signal name stays — and moving without a name change is
always allowed.

### 10.4 Load audit — `reference-unresolved` / `reference-rescued`

[`rv-reference-audit.ts`](src/core/engine/rv-reference-audit.ts) resolves every stored
reference of the open document once more, quietly — every `ComponentReference` at any depth and
every `PATH_FIELDS` entry on every registered non-alias node, with the referrer as scope. It runs
after `model-loaded`, after the placements of a load settled, on layout content added / removed
outside a load, after every structural editor op (forward, undo, redo, replay — coalesced) and
after a field edit that holds a reference. The viewer turns the result into Problems entries
(at most 200 per code, plus one summary entry; cleared on model change):

| Code | Severity | Meaning |
|------|----------|---------|
| `reference-unresolved` | error | no node answers the written path |
| `reference-rescued` | warning | a node answers only through `suffix`, `sanitized` or `name-in-scope`; the entry names the node it landed on |

Not a finding: an empty optional reference; the regular Unity spelling (root-prefixed or
root-stripped, resolving exactly in its scope); a hit through an `alias` or the `space`
normalisation (spellings the loader publishes for the authored names of renamed or sanitized
nodes — the path as written, not a fallback); a typed miss on an existing node (the target type
is not built in this viewer, or built later — the node is judged instead); a complete miss in a
late-resolution field (`LATE_RESOLUTION_FIELDS`, today `MachiningVolume.Tools`); anything inside
an `AssetOverrides` record. Referrers in placed content are audited too, in their asset's scope.

**The `_N` hint (plan-765 F6).** For an unresolved reference the audit makes three more lookups,
`<written>_1` … `<written>_3`, in the referrer's scope, accepting only full-path stages (`exact`,
`alias`, `space`, `sanitized` — never `suffix` or `name-in-scope`). When one answers, the finding
carries `dedupSuffixExists` and the `reference-unresolved` detail ends with: *"A node exists under
this path with a `_N` suffix: the file was saved by an editor before plan-765 and should be
re-exported from its source."* That is the signature of a file whose names the old editor saved in
the loader's spelling. The hint never resolves anything — there is no heuristic repair of such
files, because sibling duplicates would land on the wrong node.

**The save guard — `save-reference-loss` (plan-765 F5).** Every asset-editor save
([`rv-save-document.ts`](src/core/editor/rv-save-document.ts)) counts with
`countWrittenReferences()` from [`rv-reference-audit.ts`](src/core/engine/rv-reference-audit.ts)
twice, inside the same save: the live tree spelled in authored names (`_rvOrigName ?? name`) with
the export's prune predicate, and the export clone after the authored-name restore and both
prunes, spelled in the names the file will hold. Same iterator, same late-field rule, exact paths
only (a root-prefixed spelling is accepted), so the difference is what the serialization lost —
never what the user edited (that is the live `reference-unresolved`). The save is never blocked.

| Code | Severity | Meaning |
|------|----------|---------|
| `save-reference-loss` | warning | the file just written has `after − before` more unresolved references than the tree it came from; id `save-reference-loss:<documentId>`, detail lists the increase per `Component.field`; the next save of the document with no loss clears it (not cleared on model change — it describes a file that exists) |

The same counts ride on the `saved` outcome as `references: { before, after, byField }` and on the
`web_editor_save` result (`webviewer.mcp.md`). A guard that cannot measure (an export stub that
never clones) reports nothing and the field is absent.

### 10.5 GLB scripts — `scripts/lib/rv-glb-nodes.mjs`

Build and patch scripts edit the node tree of a glTF JSON through `createGroup`, `renameNode`,
`moveNode` and `moveNodes` (plus `nodePaths`, `findByPath`) instead of moving nodes by hand or
concatenating reference strings. Each call rewrites the stored references through the same
`planReferenceRewrite` and returns `{ referencesRewritten, nameFieldsRewritten, warnings }`.
Paths are asset-relative, with GLTFLoader's FILE-WIDE de-duplication (`A`, `A_1` anywhere in the
file); the scene's own `extras.realvirtual` (the lifted root components) is a referrer too. Rules:
errors instead of guesses (`NodeOpError` for a sibling name collision, `/` in a name, a cycle, a
missing path, a signal node whose name follows its node name, a move between parents whose world
matrices differ — the JSON stays untouched, a batch is atomic); moves keep the local transform and
are allowed only between parents with the same world matrix; every call is idempotent. The station
restructure of the LaserWeldingAssemblyStation demo is built on it.

The loader has ONE name table with five callers of `createUniqueName` — the name pots: named
scenes, named nodes, named cameras, lights (`light_<i>` when unnamed) and meshes (`mesh_<i>` when
unnamed, one claim per primitive). A test pins exactly these five call sites, so a three update
that adds a sixth fails. `createGroup` / `renameNode` refuse with `name-taken-in-file` a name whose
sanitized form is in any pot, or is a `<base>_<n>` spelling the loader generates for a later claim
(`createUniqueName` never checks whether that spelling is itself taken). Scenes, nodes, cameras and
lights are claimed synchronously, so a named node's name is deterministic; meshes claim later, in
the order their geometry promises settle. Only an unnamed node that IS a single-primitive mesh
takes the mesh's name, and when two or more mesh claims share its base that name is
order-dependent: `ambiguousLoaderNames(json)` lists such nodes and their subtrees,
`nodePaths` / `nodeNames` report the best guess, and an operation whose rewrite reads or writes such
a path returns an `ambiguous-loader-name` warning.
