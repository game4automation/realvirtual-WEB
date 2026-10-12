# Node Paths — How References Are Written and Resolved

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

Almost everything realvirtual WEB knows about a scene beyond its geometry is addressed by a
**node path**: a slash-separated string naming a node in the scene hierarchy. Component
references, instruction targets, kinematic bodies, signal addresses and persisted selections
all resolve through the same mechanism.

Node paths are strings, not identity. A path is only as stable as every name along it, and
several layers rewrite those names between Unity and the browser. This document describes what
the format is, who rewrites what, how resolution works today, and where it breaks.

Related: [doc-unity-to-web.md](doc-unity-to-web.md) (export pipeline),
[doc-signal-architecture.md](doc-signal-architecture.md) (signal flow),
[schema/v1/rv-odt.json](schema/v1/rv-odt.json) (format definition).

---

## 1. Where node paths appear

The rv-ODT schema defines the carrier type once, as `ComponentReference`:

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

The schema is written so a stable node-id field can sit **beside** `path` additively: `path`
stays valid, and a consumer prefers the id when both are present.

**That field now exists: `NodeId`** (plan-397, rv-ODT specification §5a). It is a plain string
directly under `extras.realvirtual` — not a component object — and it is the second addressing
axis, used wherever an address has to survive somebody renaming a node in a file we do not own:

- A file **we write** gets a random id per node on save, carried through unchanged on every
  later save. Regenerating it would orphan every override written against the file.
- A file **we only read** — the whole pre-existing export corpus, and every library asset that
  must stay byte-identical — gets ids **derived**, `first 16 hex of SHA-256(<file sha256> ':'
  <glTF node index>)`. Nothing random is involved, so the same bytes yield the same ids in every
  session. Stamping random ids there would be unfixable: they could never be written back.
- `NodeId` is unique **within its file**, never globally. Reference one asset ten times and all
  ten subtrees carry the same ids. The full address is therefore the pair
  `(occurrence, NodeId)`, where the occurrence is the chain of the reference nodes' ids above
  the node — computed while composing, never written into a file.
- The id carries **no `_` prefix**, deliberately: `sanitizeUserDataForExport` strips
  `_`-prefixed keys as runtime bookkeeping, and an id that does not survive an export is worse
  than none.

Implementation: [`rv-node-id.ts`](src/core/engine/rv-node-id.ts); the composite runtime index
lives in `NodeRegistry` (`registerNodeId` / `getNodeByAddress`).

**A transform override is addressed by NodeId only — there is deliberately no `trsByPath`.**
`AssetOverrides` on a reference node keys its component patches two ways, `byNodeId` and a
`byPath` fallback, but the transform block plan-444 added beside them
(`trsByNodeId`, see [doc-persistence.md](doc-persistence.md) §2.0-0a) has no path-keyed twin,
and `applyAssetOverrides` never falls through to one. The reason is that `byPath` exists purely
as a bridge for files written before NodeIds existed — and no such file can carry a transform
override, because the field did not exist then either. A path-keyed twin would therefore add a
second spelling for something nothing writes, in the one place where resolving to the wrong
node does not mis-set a value but moves geometry.

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
| **Address** of a node inside a referenced subtree | `NodeRegistry.getNodeByAddress`; the override router when a field edit inside a reference is written to the outermost reference node's `AssetOverrides.byNodeId` |
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

[`NodeRegistry`](src/core/engine/rv-node-registry.ts) holds nine maps. The
first five drive resolution; the last four are indices built on top of them.

| Map | Direction | Contents |
|-----|-----------|----------|
| `nodes` | path → node | Canonical paths **and** alias paths |
| `nodePaths` | node → path | Canonical path only — this is the reverse lookup |
| `components` | path → type → instance | Keyed by canonical path only |
| `suffixMap` | last segment → paths | Index for the suffix fallback |
| `aliasPaths` | node → alias paths | Lets `unregisterSubtree()` take aliases down with the node |
| `typeIndex` | component type → set of paths | Reverse index behind `getAll(type)` |
| `reverseRefs` | target path → `{sourcePath, fieldName, componentType}[]` | "Who points at this node?" — indexes `ComponentReference` **objects**. Built lazily on the first `getReferencesTo()` |
| `signalNameIndex` | signal name → consumers | Signal bindings are loose **strings** (`WebSensor.SignalBool = "MC07…"`), so `reverseRefs` never finds them. Built lazily on the first `getComponentsForSignal()`; invalidated by `clear()` / `recomputePathsForSubtrees()` |
| `gltfNodeIndices` | node → glTF `nodes[]` index | The `associations`-derived map handed over at load time (`setGltfNodeIndices`). Only nodes from the model GLB itself have an entry — planner placements, op-created nodes and `parseGlbSubtree` results deliberately do not, which is exactly the set the GLB bake refuses. A companion `gltfNodeNames` array lets a re-fetching writer prove the bytes match the indices |

Resolution proceeds in this order, in both `getNode()` and `getByPath()`:

1. **Exact match** on the given path.
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
nothing in glTF guarantees those names. Renaming a node in Unity silently invalidates every
stored reference leading through it, and no amount of fallback logic can recover the intent.

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
  through it. glTF has no standard for stable node identity
  ([KhronosGroup/glTF#2337](https://github.com/KhronosGroup/glTF/issues/2337) is still open);
  Three.js offers `gltf.parser.associations` as an official route back to the original node
  index, which is the direction a future ID-based reference scheme would take.

## 9. Baked models: root + logic nodes only (plan-753 / plan-754)

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
  paths of the Mauser that resolved before no longer resolve** (group-only nodes plus the plain
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
  `AssetOverrides.byPath` keys are read the same way, relative to the reference node. No file is
  migrated: the old spelling keeps resolving.
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
  `AssetOverrides.byNodeId` on a node that is not a logic node is dropped with a warning at
  instantiate time (Decision 1); `trsByNodeId` forces the addressed node into its own chunk so
  the saved transform stays visible (plan-753 I7).
- **No runtime rollback of the bake (plan-757 Phase 3, 2026-09-22).** The Visual-tab switch went
  with commit A, the localStorage `rv-webviewer-static-merge` override with commit B (a stored value
  is ignored); the only rollback is a deploy revert. A bake that FAILS is a load error
  (`BakeFailedError`, `bake-failed` problem), never an unbaked tree. Per-part addressability of bare
  CAD nodes is therefore an editor-mode property, full stop. The pick structure keeps a rollback of
  its own (`rv-webviewer-pick-structure` = `0`, the linear segment walk of `PickBackend`) — it
  changes how a chunk is picked, never which nodes exist.
- Persistence is unchanged: a placement is still saved as reference + transform
  (`AssetReference`), never as a copy of the hierarchy (Decision 11).
- **Every reference is a placement, recursively (plan-757 Phase 2, 2026-09-22).** A runtime load
  (`viewer.loadModel`, the embed facade) grafts nothing: EVERY non-`embedded` `AssetReference`
  node of the document — a planner placement (`PlacementMeta`) or a hand-authored reference —
  stays an empty node, survives the bake (`AssetReference` claims its node) and is materialised
  by the viewer's `PlacementInstancer` through the same `ModelCache` recipe as any placement; a
  reference INSIDE a placed asset is queued by the instancer itself, before the outer placement
  settles (the scene-ready contract holds). The main model is the placement at the origin that is
  not cloned, so a document with geometry of its own AND references bakes like one without.
  Only an AUTHORING load (the asset editor, recompose, descend) still grafts: the editor edits and
  saves the composed tree.
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
    reference node's `NodeId` for a document-level placement, the chain `<outer occurrence>/<reference
    NodeId>` for nested content — so `NodeRegistry.getNodeByAddress(nodeId, occurrence)` answers
    for placed content as it did for a grafted frame. Authored ids only; a node without one is
    addressed by path.
  - **Save routing — the level rule.** An edit inside a TOP-LEVEL placement (depth 1) routes to
    `AssetOverrides.byNodeId` / `trsByNodeId` on that reference node in the file being written
    (`locate()` climbs to the nearest placement root with a record). An edit under a NESTED
    reference (depth ≥ 2) is refused by name — `ReferencedFileWriteError` /
    `UnwritableTransformError` with the path and the way out ("Open the referenced asset") — because
    the nested reference node lives in the foreign file; there is no `byPath` routing below the
    first level. A `byPath` override that leads into a nested reference orphans with the reason
    `nested-reference` in the Problems panel, never silently.
  - **Refusals are visible:** a reference cycle (A → B → A, or back to the document) and a depth
    beyond `MAX_REFERENCE_DEPTH` (16) leave the node empty with a labelled placeholder and a
    `reference-cycle` / `reference-depth` problem; the per-load cap (`maxPlacementsPerLoad`,
    5000 by default) stops NESTED queueing with ONE aggregated `placement-cap` entry.
  - **Sidecars:** an unsigned placed asset gets its own `<glb>.kin.json`, exactly as a composed
    frame did (`ModelCache` applies it before the recipe); a signed asset is self-contained.
