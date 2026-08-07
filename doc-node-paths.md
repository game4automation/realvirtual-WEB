# Node Paths — How References Are Written and Resolved

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

The schema is written so a future stable node-id field can sit **beside** `path` additively:
`path` stays valid, and a consumer prefers the id when both are present.

`componentType` decides how `NodeRegistry.resolve()` interprets the path — as a Drive, a
Sensor, a signal address, or (for `UnityEngine.Transform` and for legacy entries with no
`componentType` at all) as a plain scene node.

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

---

## 3. How the exporter builds paths

`SerializationContext.GetRelativePath()`
([GLBComponentSerializer.cs:164](../../Packages/io.realvirtual.professional/Runtime/AssetManager/private/Serialization/GLBComponentSerializer.cs#L164))
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
5. **Scoped name match** (`resolve()` only, when a scope is passed) — the first descendant of
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

### Aliases for deduplicated nodes

When `GLTFLoader` renames a node, its authored path no longer exists in the scene.
[`detectRenamedNodes()`](src/core/engine/rv-glb-parse.ts) collects those nodes, and
[`registerNodeAliases()`](src/core/engine/rv-scene-loader.ts) registers the **original** path as
an alias pointing at the renamed node. `registerAlias()` writes to `nodes`, `suffixMap` and
`aliasPaths` but deliberately **not** to `nodePaths`, so the canonical reverse lookup stays
truthful. It never overwrites an existing entry.

Four properties matter:

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
Aliases registered: 12 node path(s), 3 signal path(s)
Node alias: "Kinematics_MC07/Pusher/vertical" → "Kinematics_MC07/Pusher_1/vertical"
```

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
