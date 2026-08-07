# Persistence Architecture — realvirtual WEB

This document describes how realvirtual persists state across page reloads,
tab closes, and user sessions: which storage backend each piece of state lives
in, the wire format, and the lifecycle (when it's written, when it's read, how
it's cleared).

The two top-level concerns are:

- **Working scenes, saved scenes, and autosave snapshots** — the unified
  Scene model implemented by `SceneStore` and `rv-scene-storage.ts`. This is
  the heart of "what is the user looking at, and what unsaved changes do
  they have?". See §3.0 for the precise vocabulary.
- **Auxiliary stores** — visual settings, interface config, layout
  preferences, panel state, annotations, measurements, login gate, etc. Each
  has its own narrowly-scoped key.

Further state lives outside localStorage: `IndexedDB` (File System Access
directory handles, DES experiment snapshots, the asset-editor draft), **OPFS**
(project blobs and the converted-CAD cache) and the browser **Cache API**
(planner GLB tarballs). The **project** subsystem (§3.6) sits above all of
them.

---

## 1. Storage backends at a glance

| Backend | Used for | Survives reload? | Survives tab close? | Cleared by |
|---|---|---|---|---|
| **localStorage** | Almost everything: scenes, drafts, settings, overlays, presets, panel state | ✅ | ✅ | `clearAllRVStorage()` / Settings → "Reset all" |
| **sessionStorage** | Tab-scoped ephemeral state: sensor history panel layout, order cart, login gate auth | ✅ | ❌ | Tab close (browser-managed) |
| **IndexedDB** (`rv-filesystem`) | `FileSystemDirectoryHandle` for the user-selected working folder | ✅ | ✅ | `removeWorkFolder()` / Settings → Local Folder → Remove |
| **Cache API** (`rv-planner-glbs`) | Network cache for planner library GLBs | ✅ | ✅ | `ModelCache.clearPersistentCache()` |
| **OPFS** (`core/storage/rv-opfs-blobs`) + **Cache API** (`rv-cad-glbs`) | Converted-CAD GLB bytes, keyed by `(sha256, quality)` — how an `importCad` op replays without re-tessellating (§7.8) | ✅ | ✅ | `clearCadGlbCache()` |
| **OPFS / IndexedDB / localStorage** (`rv-project/*`) | Project subsystem — which project is open, its backend, its blobs (§3.6) | ✅ | ✅ | Project delete / browser site-data clear |
| **URL query string** | Active scene id / built-in filename / model URL — round-trip across bookmarks and reloads | ✅ (re-read on boot) | ❌ | New URL |
| **In-memory** (`SceneStore`, op buffer, redo stack, transaction buffer) | Live workspace state; flushed to localStorage on debounce | ❌ | ❌ | Lost on reload unless autosaved |

[`src/core/hmi/rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts) holds
`ALL_RV_STORAGE_KEYS` and `clearAllRVStorage()` (used by Settings → "Reset
all").

**`ALL_RV_STORAGE_KEYS` is a *sweep list*, not an inventory.** It enumerates
the keys "Reset all" removes — nothing enforces that a store registers its key
there, and roughly forty live keys are missing from it, including nine this
document describes (`rv-hmi-visible`, `rv-connect-url`, `rv-env-user-modified`,
`rv-pipe-coloring-enabled`, `rv-pu-mode-enabled`, `rv-scenes-cleared-legacy`,
`rv-layout-rotation-snap`, `rv-layout-bbox-snap-enabled`, `rv-active-mode`).
A key absent from the list and from `RV_DYNAMIC_PREFIXES` **survives "Reset
all"** — which is sometimes correct (`rv-scenes/*`, §9.1) and sometimes simply
an omission. Treat the file as the place to *register* a key, not as the place
to *look one up*.

---

## 1.5 What is persisted, when, where — at a glance

This table is the cheat-sheet. Every persisted piece of state is described
later in this document, but the most common question is "**when does each
thing actually get written?**".

| What | Where | **Write trigger** | Read trigger |
|---|---|---|---|
| **Working-scene op log** (autosave snapshot) | `localStorage rv-scenes/draft/<base>` or `rv-scenes/scene-draft/<id>` | Every op application, **debounced 2000 ms** (`DRAFT_AUTOSAVE_DEBOUNCE_MS`) | `openScene(id)` / `openBuiltin(url)` / `openEmpty()` at boot |
| **GLB-node signal bindings** (`kind: 'node'`) | Working-scene `setField` op: `SignalLinks.Mappings` | Every bind, unbind, or confirmed mapping edit | Scene replay / model load via `SignalBindPlugin` |
| **Placement signal bindings** (`kind: 'placed'`) | `PlacedComponent.signalMappings` inside the placement record | Every bind/unbind — written straight through `LayoutStore.updateSignalMappings()`, **no** `setField` op | With the placement, on `addPlacement` replay |
| **Saved scene** (an entry in *My Scenes*) | `localStorage rv-scenes/<id>` + `rv-scenes-index` | **Explicit user action**: Save / Save as… / Duplicate / Import / Rename | `openScene(id)` |
| **Active-scene pointer** | `localStorage rv-scenes/active` | `save()` / `openScene()`; cleared when opening an unsaved built-in | Boot fallback when `?scene=` is missing |
| **URL `?scene=…`** | History API (no storage) | Every workspace switch via `history.replaceState` | Boot, on every reload |
| **Visual / interface / search / multiuser settings** | `localStorage rv-<area>-settings` | **Every setter call** in the respective store (no debounce — synchronous) | Lazy on first access |
| **Per-group visibility** | `localStorage rv-group-visibility` | On every visibility toggle | Scene/model load + UI mount |
| **Per-model camera preset** | `localStorage rv-camera-start:<modelKey>` | `saveStartPos()` / `clearStartPos()` (also via `setCamera` op) | `scene-loaded` event |
| **Per-model annotations / measurements** | `localStorage rv-annotations-<hash>` / `rv-measurements-<hash>` | On create / edit / delete | Model load |
| **Layout Planner UI state** (grid, snaps, tabs, library URLs) | `localStorage rv-layout-…` | On every toggle / value change | Planner panel mount |
| **Hierarchy / Inspector / panel UI state** | `localStorage rv-hierarchy-… / rv-inspector-… / rv-extras-editor-…` | On every UI change (expand, resize, select) | Panel mount |
| **Working-folder handle** | `IndexedDB rv-filesystem` | On user folder selection | Settings → Local Folder open |
| **Working-folder display name** | `localStorage rv-local-folders` | Same call that writes the IDB handle | Settings UI render |
| **Planner GLB tarballs** | `Cache API rv-planner-glbs` | First fetch of a catalog GLB | Every subsequent fetch (cache-first) |
| **Sensor history panel layout** | `sessionStorage rv-sensor-history` | On panel drag / resize | Panel mount in same tab |
| **Order Manager cart** | `sessionStorage rv-order-cart` | On cart add / remove | Panel mount in same tab |
| **Login Gate auth** | `sessionStorage rv-login-auth` (default) | On successful login | Page load |
| **Settings bundle (export)** | Downloaded JSON file (not localStorage) | **Explicit user action**: Settings → Backup → Export | Settings → Backup → Import |
| **Settings sidecar (auto-load)** | Fetched from `<modelUrl>.settings.json` | (never written by viewer) | First model open, when `rv-visual-settings` is absent |

Two patterns to internalize:

1. **The working-scene op log is debounced (2 s); every other store writes
   synchronously on change.** The auxiliary stores trade write volume for
   simplicity — they're small enough that per-keystroke writes don't matter.
   The op log is large enough that debouncing matters, hence the 2-second
   window.

2. **localStorage is the resume mechanism; the URL is the bookmark.** A reload
   restores state from localStorage; sharing a link restores state from the
   URL. They're independent layers — clearing one does not clear the other.

### Signal binding persistence (current state)

`createSignalBindingPersistence()`
([`src/plugins/signal-bind/signal-binding-persistence.ts`](src/plugins/signal-bind/signal-binding-persistence.ts))
picks one of **two** homes from the bind target's `kind`:

- **`kind === 'placed'`** — a Layout-Planner placement. The mappings are written
  straight into `PlacedComponent.signalMappings` through
  `LayoutStore.updateSignalMappings()`. **No `setField` op is produced**; the
  binding travels with the placement record and is replayed by the
  `addPlacement` op that carries it. Undo of a binding edit therefore does not
  go through the scene op history.
- **`kind === 'node'`** — a regular GLB node. The mappings are stored in the
  scene op log as
  `setField(componentType: 'SignalLinks', fieldName: 'Mappings', value: ...)`,
  plus a `WeakMap`-backed runtime mirror kept coherent by
  `syncNodeSignalBindingPersistence()` on forward, undo and redo. This is an
  overlay only: the loaded GLB bytes and the component's original signal
  references are not modified.

A `SignalMapping` carries nine fields — `kind`, `componentPath`, `slot`,
`sourceKind`, `signal`, `interfaceId`, `topic`, `direction`, `enabled`. Legacy
records omit the optional ones; every read site normalizes `sourceKind` through
`mappingSourceKind()` (`?? 'connect'`).

This is the *editing* home. To make bindings travel with the model instead of
with the browser profile, write them into the GLB (§6.1) — `SignalBindPlugin`
reads `SignalLinks.Mappings` straight off the loaded scene graph, so a written
file needs no op log at all.

Each mapping stores `interfaceId` and optional `topic` provenance. Legacy
mappings without provenance migrate only when exactly one full provider key
advertises the signal; no provider remains pending and multiple providers are a
visible conflict. Successful migration is written back through the same scene
op. On model reload, connected interfaces re-register discovered signals and
rebuild outgoing subscriptions against the new `SignalStore`, so feedback
writeback continues without reconnecting the transport.

---

## 2. The unified Scene model

The Scene model is the canonical container for "what the user is editing".
It composes a **base GLB** (built-in or empty) with an ordered **operation
log** that captures every edit.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            RvScene                                  │
│  id, name, createdAt, modifiedAt                                    │
│  base:  { kind: 'builtin'; url; label } | { kind: 'empty' }         │
│  edits:                                                             │
│    ops:      [ EditOp, EditOp, … ]   ← operation log (history)      │
│    settings: { catalogUrls, gridSizeMm }                            │
│  thumbnailDataUrl?, parentId?, description?                         │
└─────────────────────────────────────────────────────────────────────┘
```

The op log is the single source of truth for edits. **Replaying it
deterministically on top of the base GLB materializes the live state**
(component property overrides + planner placements + camera preset). This is
how `SceneStore.openScene()` rebuilds an arbitrary scene on load: it does not
write a snapshot, it writes the ops, then replays them through the executors.

See [`src/core/hmi/scene/rv-scene-types.ts`](src/core/hmi/scene/rv-scene-types.ts)
and [`src/core/hmi/scene/rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts).

### 2.1 Edit operations

Every user edit produces an immutable `EditOp` record. There are **fourteen**
primitive op kinds plus a `composite` for transactions:

| Kind | What it does | Inverse via |
|---|---|---|
| `setField` | Set `userData.realvirtual[componentType][fieldName] = value` on a node | `prev` (or `unsetField` if `prev === undefined`) |
| `unsetField` | Remove an override and restore the GLB default | `prev` value |
| `setCode` | Set or replace an inline script body (e.g. a custom runtime instruction) | `prev` (or `unsetField` when there was none) |
| `addPlacement` | Spawn a planner-catalog object (Layout Planner) | `removePlacement` of same id |
| `removePlacement` | Remove a planner placement | Re-`addPlacement` carrying the snapshot |
| `transformPlacement` | Move/rotate/scale a placement | `prev.{position,rotation,scale}` |
| `setNodeTransform` | Move/rotate/scale a plain scene node (not a placement) | `prev` transform |
| `setCamera` | Set or clear the per-scene camera start preset | `prev` preset |
| `addNode` | Create a new node under an existing parent (e.g. an inserted IK path waypoint) | `removeNode` with the same node path |
| `removeNode` | Remove a node created by an `addNode` op; carries the full spec so undo can re-create it | Re-`addNode` from the snapshot |
| `addConnection` | Add a connection edge (plan-259), applied additively on top of the GLB-authored `Connections` block | `removeConnection` of the same edge |
| `removeConnection` | Remove a connection edge | Re-`addConnection` from the snapshot |
| `setConnectionType` | Define or redefine a user connection-type signature | `prev` signature, or `removeConnectionType` when there was none |
| `removeConnectionType` | Drop a user connection-type signature | Re-`setConnectionType` from the snapshot |
| `composite` | Group several primitives into one undo unit | Each child inverse, in reverse order |

Every primitive op carries its own inverse (`prev` field) so undo never
re-runs the forward executors against missing or stale state. Composites are
flattened recursively when materializing.

### 2.2 The op queue, transactions, and coalescing

`SceneStore` serializes all op application through a single-flight async
queue (`_opQueue`):

```
applyOp ─┐
         ├─► _enqueue ─► await applyForward(op) ─► _pushOp ─► debounced autosave
undo ────┤              await applyInverse(op)
redo ────┘
```

- **No concurrency**: ops apply one at a time. `addPlacement` (which loads a
  GLB) cannot interleave with a `setField`.
- **In-flight loads**: while `_loading === true` (during `openScene` /
  `openBuiltin` / `newEmpty`), ops are dropped — the load itself is replaying
  the canonical state and any user input would race against it.
- **Transactions**: `beginTransaction(label)` + `endTransaction()` wraps a
  sequence of primitives into one composite op. Forward applies happen
  immediately on each primitive (so the live scene reflects each step), but
  only one entry lands on the history → one undo reverts the whole gesture.
  `withTransaction(label, fn)` is the RAII helper.
- **Coalescing**: adjacent primitives on the same target within
  `COALESCE_WINDOW_MS = 500` ms merge into the head op. Typing into a number
  field doesn't bloat the history; a single undo still reverts the entire run
  because `prev` is preserved from the first op. Coalescing only happens
  **above the baseline** so it can never corrupt the inverse needed to reach
  the persisted starting state.
- **History cap**: `MAX_OP_HISTORY = 500`. When the cap is exceeded, the
  oldest ops drop off the front and the baseline shifts in lockstep so the
  undo floor stays consistent.

### 2.3 Materialization (replay)

`materialise(ops)` in [`rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts)
folds an op array into the shape the engine subsystems already consume:

```ts
interface MaterialisedEdits {
  overlay:         RVExtrasOverlay          // → loadGLB (applied during traversal)
  placements:      PlacedComponent[]        // → planner.applyPlacements()
  cameraStart:     ModelCameraStart | null  // → camera-startpos plugin
  addedNodes:      AddedNode[]              // → nodes created by addNode ops
  nodeTransforms:  NodeTransformEntry[]     // → setNodeTransform overrides
  connections:     RvConnection[]           // → ConnectionSystemPlugin, ADDITIVE on
                                            //   top of the GLB-authored Connections
  connectionTypes: ConnectionType[]         // → user-defined type signatures
}
```

It is a **pure function** — same input, same output, every time. This is the
determinism property that makes save/load round-trips safe.

`RVViewer.loadScene(scene)` in [`src/core/rv-viewer.ts`](src/core/rv-viewer.ts)
applies materialized edits in a fixed phase order:

```
0. materialise(ops)                    — fold ops
1. resolve base URL (built-in / empty) — empty = synthesised in-memory GLB
2. clear previous planner placements
3. loadModel(url, { overlay })         — overlay applied during GLB traversal
4. planner.applyPlacements(...)        — only if scene has placements
5. emit 'scene-loaded'                 — camera-startpos plugin re-tweens
```

---

## 3. localStorage layout for the Scene model

### 3.0 Vocabulary — three concepts at the workspace level

To avoid confusion, this document uses three precise terms instead of the
overloaded word "draft":

| Term | What it is | Where it lives |
|---|---|---|
| **Working scene** | The live editing session — an op log on top of a built-in or empty base. The Inspector, Hierarchy and Planner all act on this. | `SceneStore._workspace` (in-memory) + autosave snapshot (localStorage) |
| **Autosave snapshot** | A debounced backup of the working scene's op log. The reload-survival mechanism — nothing more. | `localStorage rv-scenes/draft/<baseKey>` or `rv-scenes/scene-draft/<id>` |
| **Saved scene** | A named, persistent record. Appears as a row under **My Scenes** in the Models panel. Created by Save / Save as… / Duplicate / Import. | `localStorage rv-scenes/<id>` + index entry in `rv-scenes-index` |

The **My Scenes** list in the UI is the set of saved scenes — it is **not** a
view onto the autosave snapshots. Editing a built-in stays in the autosave
snapshot only; it never appears in *My Scenes* until the user explicitly
clicks **Save as…**.

The Models panel has a third, read-only **Examples** section. Examples are
curated demo scenes shipped with the build under `public/scenes/*.scene.json`,
listed from the curated manifest `public/scenes/index.json`
(`[{ file, name, mode }]`). `discoverPublishedScenes()` (`main.ts`) fetches
**that manifest and nothing else** — there is no build-time glob fallback, so a
scene file without an `index.json` entry is invisible. They are **not** stored
in localStorage:

- Clicking an Example opens it **transiently** (`openPublishedExample` →
  `openPublished`, which loads it as an unsaved working scene and writes
  `?scene=published:<name>` to the URL — nothing is persisted). The example's
  preferred workspace mode (e.g. `planner`) is applied from the manifest entry.
- **Add to My Scenes** (`addPublishedToMyScenes`) materialises the example as a
  fresh, fully editable **saved scene** with a new `scn_<…>` id (its display
  name de-duplicated against existing scenes), then opens it — this is the path
  for turning a demo into something the user owns and can edit.

Examples are part of the public demo deploy only, gated in two independent
places:

- **Staging** — `copyCore(…, { includePublicDemoContent })` in
  [`scripts/_workspace-lib.mjs`](scripts/_workspace-lib.mjs) excludes
  `public/scenes/` **and** `public/aasx/` from the copied source tree unless the
  deploy is the public core demo. A customer workspace never receives the files
  at all, so nothing has to be deleted from `dist/` afterwards.
- **Runtime** — `discoverPublishedScenes()` returns `[]` outright when
  `import.meta.env.VITE_PRIVATE_BUILD` is set, so even a build that somehow
  carries the folder shows no Examples section.

Public deploys go one step further: `bunny-deploy.mjs` prunes every
`Test*.scene.json` (file **and** `index.json` entry, prefix configurable via
`RV_PUBLIC_TEST_SCENE_PREFIX`) so dev fixtures never reach the demo.

This is why the UI shows two buttons:

- **Save** — only enabled when the working scene already has a saved-scene
  id (`_saved != null`) and there are unsaved edits. Overwrites
  `rv-scenes/<id>` in place.
- **Save as…** — always enabled. Mints a new `scn_<…>` id, adds a row to
  *My Scenes*, and clears the autosave snapshot for the working scene.

The **UNSAVED** chip means *"the working scene has edits beyond its baseline"*.
It does **not** mean "you'll lose this on reload" — the autosave snapshot is
written every 2 s and restored on next boot. The chip exists to nudge the user
toward creating a named saved scene before the autosave snapshot gets
overwritten by switching workspaces.

### 3.1 localStorage layout

All Scene-related keys live in [`src/core/hmi/scene/rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts).
Five keyspaces, one job each:

| Key / Prefix | Shape | Purpose |
|---|---|---|
| `rv-scenes-index` | `RvSceneMeta[]` (sorted by `modifiedAt` desc) | Cheap list rendering in the Projects dashboard without parsing every full scene |
| `rv-scenes/<id>` | `RvScene` (schemaVersion: 2) | Full saved scene record |
| `rv-scenes/active` | `{ id }` | Pointer to the most recently active saved scene — used as a boot-time defense-in-depth fallback when `?scene=` is missing |
| `rv-scenes/draft/<baseKey>` | `RvScene` | **Per-base autosave snapshot.** Used while the working scene has no saved id (`_saved == null`) — i.e. an untitled built-in or empty workspace |
| `rv-scenes/scene-draft/<savedId>` | `RvScene` | **Per-saved-scene autosave snapshot.** Used while the working scene has a saved id, keyed by id so multiple scenes built on the same base don't collide |

Where:
- `baseKeyOf({ kind: 'empty' })` → `'empty'`
- `baseKeyOf({ kind: 'builtin', url })` → `'builtin:' + encodeURIComponent(url)`

**The per-base draft key is project-scoped.** `setDraftScope(projectId)`
(module state in `rv-scene-storage.ts`, set when a project opens) makes
`draftKey()` emit `rv-scenes/draft/<projectId>:<baseKey>` instead of the bare
`rv-scenes/draft/<baseKey>`. Without it two projects sharing the same base GLB
would resurrect each other's unsaved drafts — `baseKeyOf()` knows nothing about
projects. "No project" keeps the historic unscoped key, so pre-project drafts
stay exactly where they are. The per-*saved-scene* slot
(`rv-scenes/scene-draft/<id>`) is **not** scoped: a saved-scene id is already
globally unique.

### 3.2 Two autosave snapshots — why?

The split exists because a working scene can be in one of two qualitatively
different states:

| Working-scene state | Saved? | Autosave snapshot | Resumed by |
|---|---|---|---|
| Fresh built-in or "Untitled" empty | `_saved == null` | `rv-scenes/draft/<baseKey>` | `openBuiltin(url)` / `openEmpty()` |
| Edits on top of a saved scene | `_saved != null` | `rv-scenes/scene-draft/<savedId>` | `openScene(savedId)` |

`SceneStore` has two empty-scene entry points that look similar but differ on
snapshot semantics:

- **`newEmpty()`** — explicit "New empty scene" gesture. Always discards the
  per-base empty snapshot and starts fresh.
- **`openEmpty()`** — resume-or-create. Mirrors `openBuiltin()`. Used by the
  boot path on `?scene=empty` so a reload preserves edits made on an
  untitled workspace.

Without the split, two saved scenes sharing the same base GLB would clobber
each other's snapshots. Two scenes that both forked from `factoryDemo.glb`
keep their unsaved edits independent because they have distinct saved ids and
write to separate `scene-draft/<id>` slots.

The per-base slot only exists for "I haven't saved this yet" working scenes;
on the first `save()`, the per-base slot is cleared and only the
per-saved-scene slot applies thereafter.

### 3.3 Autosave — when exactly does it write?

The autosave snapshot is written by `_afterOpsChanged()` on a debounced timer
(`DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000` ms). The condition is a single
`if/else` — there are **two** effective branches, not three:

```
if (canUndo || canRedo || _saved == null):     // working scene has content
    if _saved != null  → writeSceneDraft(_saved.id, snapshot)
    else               → writeDraft(_workspace.base, snapshot)
else:                                          // pristine: edits match baseline
    if _saved != null  → clearSceneDraft(_saved.id)
    // NB: no clearDraft(base) here — the per-base slot is *not* cleared
    //     in the pristine path. It is only cleared on first save() / saveAs().
```

The autosave timer is cancelled at the top of every `_loadIntoWorkspace()`
call so an in-flight save can't write the previous workspace's state into
the new workspace's slot.

### 3.4 Save / Save as… / Discard / Delete semantics

| Operation | What happens | Snapshot slots |
|---|---|---|
| **Save** (`save()`) | First save: mints `scn_<…>` id, writes `rv-scenes/<id>` + index meta, sets `rv-scenes/active`. Subsequent saves: overwrite same id. | Both per-base and per-saved-scene snapshots cleared |
| **Save as…** (`saveAs(name)`) | Always mints a new id; `parentId` set to current `_saved?.id`. Adds a new row under *My Scenes*. | Same as above |
| **Discard** (`discard()`) | Re-opens last-saved scene, **first clearing the per-saved-scene snapshot** so we don't restore the very edits we're discarding | Per-saved-scene snapshot cleared, then read |
| `delete(id)` | Removes scene blob + index entry. Also `clearSceneDraft(id)` to prevent stale snapshots surviving id collisions | Per-saved-scene snapshot cleared |
| `rename(id, name)` | Index + body updated atomically (body first, then meta) | Untouched |
| `duplicate(id)` | Writes a fresh `scn_<…>` body; bumps `parentId` | Untouched |

The **Save** button in `SceneActiveCard` is enabled when
`!isDraft && !!saved && dirty`. "Disabled Save" means there is no saved-scene
id yet — the user must use **Save as…** to create one. After that, Save is
the in-place overwrite.

### 3.5 URL routing

`SceneStore` always reflects the active workspace into the URL via
`history.replaceState`:

| URL form | Effect on boot | Written by |
|---|---|---|
| `?scene=<scn_…>` | `openScene(id)` (highest priority) | `save()`, `saveAs()`, `openScene()` |
| `?scene=builtin:<filename>` | `openBuiltin(url)` for the matching entry | `openBuiltin()` |
| `?scene=empty` | `openEmpty()` (resume per-base empty draft if present) | `newEmpty()` and `openEmpty()` |
| `?scene=published:<name>` | Fetches `public/scenes/<name>.scene.json` and opens it transiently (`openPublished`); the matching Examples catalogue entry's `mode` is applied unless `?mode=` overrides | `openPublished()` (no localStorage write) |
| `?model=<url>` | Legacy alias — deprecated, falls through to default-model boot |  |
| (no `scene` param) | Falls back to: saved active id (`rv-scenes/active`) → `?model=` → `LS_KEY_MODEL` → `defaultModel` from settings.json → first available | — |

The URL is the bookmarkable identity; localStorage is the resume mechanism.
`rv-scenes/active` is defense-in-depth for cases where the URL was lost
(bookmark predating the URL-write fix, code path that forgot to call
`updateUrlSceneParam`, etc.).

### 3.6 The project subsystem (`src/core/project/`)

Since plan-372 the Scene keyspace sits *inside* a **project**: a named container
that owns models, library assets, scenes and blobs. It is a distinct subsystem
with its own storage and its own lifecycle, and this document does not attempt
to duplicate it — the pointer matters more than a partial copy.

Three interchangeable backends behind one `ProjectBackend` interface
([`src/core/project/backends/`](src/core/project/backends/)):

| Backend | Storage | Notes |
|---|---|---|
| **folder** | A user-picked directory via the File System Access API (`selectFolderForKey`, readwrite) | Durable, user-owned, shareable. The successor to the old "working folder". |
| **browser** | OPFS blobs + `localStorage rv-project/browser/<id>` | Zero-setup default; evictable like all browser storage. |
| **bundled** | Read-only, shipped with the build (`library/catalog.json` etc.) | The Sample project. `writeBlob` is refused with a reason. |

The `rv-project/*` localStorage keyspace:

| Key | Purpose | Owner |
|---|---|---|
| `rv-project/last` | Id of the last opened project — restored on boot | `project-store.ts` |
| `rv-project/recent` | Recent-project list for the picker | `rv-project-recent.ts` |
| `rv-project/workspace` | The workspace root that contains project folders | `rv-project-workspace.ts` |
| `rv-project/migration` | One-shot migration state (legacy loose keys → project) | `rv-project-migration.ts` |
| `rv-project/workfolder-offer` | "Adopt your old working folder as a project?" was offered | `rv-project-migration.ts` |
| `rv-project/browser/<id>` | Metadata for a browser-backend project | `browser-backend.ts` |

Two couplings back into this document: the project id scopes the per-base draft
key (§3.1), and `saveSettingsIntoModel()` writes through
`ProjectBackend.writeBlob` (§6.1), which is why "bundled" refuses that write.

---

## 4. Boot path: how a reload restores state

Sequence in [`src/main.ts`](src/main.ts):

```
1. Init RVViewer, register plugins (Layout Planner, etc.)
2. initSceneStore(viewer)              ← reads catalogue indexes
3. migrateLegacyAutosave()             ← one-shot legacy migration (idempotent)

4. Resolve which scene/model to load:
   ┌──────────────────────────────────────────────────────────────┐
   │ a. ?scene=<id>           → SceneStore.openScene(id)          │
   │ b. ?scene=builtin:<file> → SceneStore.openBuiltin(url, label)│
   │ c. ?scene=empty          → SceneStore.openEmpty()            │
   │ d. (else) rv-scenes/active id → SceneStore.openScene(activeId)│
   │ e. (else) ?model=<url> + LS_KEY_MODEL + defaultModel + first │
   │       → SceneStore.openBuiltin(finalUrl, label)              │
   └──────────────────────────────────────────────────────────────┘

5. SceneStore.openScene(id):
   - readScene(id)           ← rv-scenes/<id>
   - readSceneDraft(id)      ← rv-scenes/scene-draft/<id>  (resume!)
   - sceneToLoad = draft ?? scene
   - viewer.loadScene(sceneToLoad)
   - writeActiveId(scene.id)   ← saved id, NOT draft id
   - updateUrlSceneParam(scene.id)

6. SceneStore.openBuiltin(url, label):
   - readDraft({ kind:'builtin', url })  ← rv-scenes/draft/<baseKey>  (resume!)
   - scene = restored ?? makeDraftScene(base, label)
   - viewer.loadScene(scene)
   - writeActiveId(null)       ← unsaved drafts don't claim the active slot
```

Step 5 is the key reload-survival mechanism for **saved scenes with unsaved
edits**: `openScene` always prefers the per-saved-scene draft over the saved
snapshot. Step 6 is the equivalent for **fresh drafts**.

### 4.1 Additional boot-time branches

Beyond the SceneStore routing above, `main.ts` runs a handful of other
branches that influence what gets loaded and what gets persisted. They are
not part of the Scene model but they shape the user's first paint:

| Branch | Trigger | Effect |
|---|---|---|
| **Microsoft Teams app** | `?teams=1` in URL | Initialises the Teams JS SDK, extracts user context, auto-injects `?name=<user>` for Multiuser identity |
| **Performance test mode** | `?perf` in URL | Locks settings (`appConfig.lockSettings = true`), loads the PerfTestPlugin |
| **MCP bridge** | `?mcp` in URL (or DEV mode) | Enables the MCP bridge plugin so AI tools can introspect the live scene |
| **Firebase demo deploy** | URL path matches `/demo/webviewer/<demoName>` | Loads the GLB directly from Firebase Storage; bypasses the normal `?scene=` routing |
| **Private project models** | Server provides `GET /__api/private-models` | Adds entries to the Models panel from a server-side allowlist |
| **Authoritative model manifest** | `public/models.json` present | Overrides directory-listing-based model discovery — critical for private deploys |
| **Local-filesystem model discovery** | User granted a working folder (see §7.6) | Surfaces `.glb` files in the folder's `models/` subdirectory inside the Models panel |

None of these branches write to the Scene model; they only influence which
GLB the SceneStore is asked to open. Once `openBuiltin()` / `openScene()` is
called, the regular boot path takes over.

### 4.2 The legacy fallback path

If a `?model=` URL or `LS_KEY_MODEL` resolves and no `?scene=` was set, the
legacy default-model boot is now routed through `sceneStore.openBuiltin(...)`
rather than `loadModel(...)` directly. This was an explicit fix: the bare
`loadModel` path eventually called `markGlbActive(url, label)` which builds
a workspace with **empty baseline** — discarding any per-base draft that had
been autosaved. Routing through `openBuiltin` consults the `rv-scenes/draft/`
slot, restoring property-inspector edits across reload even when the URL was
not explicitly `?scene=builtin:`.

`markGlbActive` is still called by the `loadModel` fast-path inside `main.ts`
for cases where loading is initiated outside the SceneStore (Firebase demo
mode, `loadModelWithProgress` chained from settings UI). It is a no-op while
`_loading` is true, so it cannot stomp an in-flight `openBuiltin`/`openScene`.

---

## 5. Edit executors — turning ops into live changes

[`rv-scene-executors.ts`](src/core/hmi/scene/rv-scene-executors.ts) is the
boundary between the pure op log and the live Three.js scene. Each primitive
kind has a forward + inverse function:

| Op kind | Forward | Inverse |
|---|---|---|
| `setField` | Write `userData.realvirtual.<comp>.<field>`, then `applySchema()` so the live component instance (e.g. `RVDrive.TargetSpeed`) reflects the value | Restore `prev` (or `delete` if `prev === undefined`) and re-apply schema |
| `unsetField` | Delete the field, re-apply schema (instance falls back to GLB default) | Write `prev` and re-apply schema |
| `addPlacement` | `LayoutPlannerPlugin.placeFromRecord(placement)` (loads the catalog GLB if not already cached) | `removePlacementById(id)` |
| `removePlacement` | `removePlacementById(id)` | `placeFromRecord(placement)` from the snapshot |
| `transformPlacement` | `applyTransformById(id, pos, rot, scale)` | Same with `prev.{pos,rot,scale}` |
| `setNodeTransform` | `applyLocalPose(node, position, quaternion)` on the registry node; a missing node is tolerated (the base GLB may have changed) | Same with `prev.{position,quaternion}` |
| `setCamera` | `saveStartPos(modelKey, preset)` or `clearStartPos(modelKey)` (writes `rv-camera-start:<modelKey>`) | Same with `prev` |
| `setCode` | Write the script body into the WebComponent code field, then re-apply schema | Restore `prev`, or delete the field when `prev === undefined` |
| `addNode` | `viewer.createComponentNode(spec)` + `rebuildIKPaths()` | `removeComponentNode(nodePath)` |
| `removeNode` | `viewer.removeComponentNode(nodePath)` + `rebuildIKPaths()` | `createComponentNode(spec)` from the snapshot |
| `addConnection` | `ConnectionSystem.addConnection(connection)` | `removeConnection(connection.id)` |
| `removeConnection` | `ConnectionSystem.removeConnection(connectionId)` | `addConnection(connection)` from the snapshot |
| `setConnectionType` | `ConnectionSystem.setConnectionType(type)` | `prev` signature, or `removeConnectionType` when there was none |
| `removeConnectionType` | `ConnectionSystem.removeConnectionType(type.type)` | `setConnectionType(connectionType)` |

All execution is wrapped in `try/catch` — a failed primitive op logs a
warning but never throws across the SceneStore boundary. **This is what lets
a saved scene whose base GLB later changed (some node went missing) still
load**: the stale ops are skipped, the rest replay cleanly. The user sees
the edits that still apply and a console warning for the ones that don't.

Composite ops are not atomic in this sense: each child is wrapped
individually, so a composite of (setField, setField, addPlacement) where the
middle child fails will still apply the first and third. This is the right
default for replay-on-load, but it means a composite that records a
multi-step gesture can produce a partial result if the scene has drifted.
For inverses (undo), the same per-child wrapping applies in reverse order.

`setCamera`'s forward path writes the per-model camera preset
(`rv-camera-start:<modelKey>`) directly — the camera startpos store is the
storage backend, not a parallel state. This is why camera presets carried
through ops (i.e. in the scene's `edits.ops`) and the per-model preset in
localStorage agree without explicit sync code.

---

## 6. JSON import / export of scenes

`SceneStore.exportSceneJSON(id)` writes a `*.scene.json` file containing the
full `RvScene` record (id, name, base, ops, settings). `importSceneJSON(file)`
validates `schemaVersion === 2`, mints a fresh id (so import never collides
with an existing entry), and adds the imported scene to the index with
`parentId` set to the original id (provenance only).

### 6.1 Saving scene settings into the model

`SceneStore.saveSettingsIntoModel(name)` writes the working scene's property
overrides INTO a copy of its base GLB and adopts that copy as the new
baseline. It is the answer to "this configuration only exists in my
browser": after a write the settings travel with the file, and the scene
starts again with an empty op log.

The mechanics are in
[`rv-scene-settings-into-model.ts`](src/core/hmi/scene/rv-scene-settings-into-model.ts) and
[`rv-glb-chunks.ts`](src/core/persistence/rv-glb-chunks.ts):

- **Only the JSON chunk is rewritten.** A GLB is header + JSON chunk + BIN
  chunk, and every override lives in `nodes[i].extras`. The BIN chunk is
  copied as an opaque tail, so the geometry of the written file is
  bit-identical to the source. Nothing goes through `GLTFExporter`, so none
  of its losses (triangle ceiling, silently dropped empty meshes, skinned
  rigs) apply. Pinned by `tests/rv-glb-chunks.node.test.ts`.
- **The merge mirrors `applyOverlayToNode` field for field** — assignment per
  field, `null` deletes, and the component object is created even when it
  ends up empty. A deviation would make the written file behave differently
  from the scene the user was just looking at.
- **Node paths resolve through `associations`, never through names.**
  `collectGltfNodeIndices` (`rv-glb-parse.ts`) captures the Object3D → glTF
  index map at load time and hands it to the `NodeRegistry`
  (`getGltfNodeIndex`). Re-deriving it from names would have to reimplement
  three.js' file-global dedup ordering plus the `detectRenamedNodes` restore
  rule — the one place this design could silently write to the wrong node.
- **Only `setField` / `unsetField` / `setCode` can be written in.** Placements,
  added or moved nodes and connections are structural; a scene carrying any
  of them is refused with a list of what is in the way rather than
  half-written. `cameraStart` is the exception — it lives outside the GLB in
  `rv-camera-start:<modelKey>` and is re-keyed onto the new model instead.
- **`rv_sig` is dropped.** The signature covers the whole file, so any JSON
  edit invalidates it. Leaving a stale one would make the model load as
  `invalid`, which gates ALL component logic — the machine would render and
  not run. Re-signing belongs after the write, never before.
- **The source bytes are re-fetched, and then proven to be the same file.**
  Holding the 35 MB source for every model's lifetime is the double-buffering
  that caused out-of-memory blank scenes on mobile, so the bytes are fetched
  again here. But node indices are only meaningful against the file they came
  from: if the URL served something else in between (a redeployed model, a
  republished CONNECT model), index N now means a different node and a PLC
  link would land on the wrong machine part. `collectGltfNodeNames` captures
  the raw glTF names at load; a mismatch raises `ModelSourceChangedError`
  instead of writing. An empty name list means "not captured" and skips the
  check — never "expected zero nodes".
- **Values that JSON cannot carry are refused.** `JSON.stringify` turns `NaN`
  and `±Infinity` into `null` and drops `undefined`, silently.
  `UnrepresentableValueError` names the exact node → component.field instead.
- **The whole transaction runs inside the op queue.** Fetching and writing
  takes seconds, and `applyOp` / `undo` / `redo` queue there too — draining
  the queue up front and then working outside it would let an edit apply
  mid-flight and then be erased by the empty op log the adoption installs.
  Scene *loads* bypass the queue, so the workspace is re-checked before
  adoption; a switch mid-write yields `scene-changed` and leaves the scene
  alone. Any failure after `writeBlob` deletes the file again — an orphan in
  `models/` is indistinguishable from a finished delivery.

The output is written through `ProjectBackend.writeBlob` to `models/<name>.glb`
(folder → disk, browser → OPFS, bundled → refused with a reason), then
reopened via `openBuiltin` — which reloads from the bytes just written and is
therefore also the cheapest proof that the write is loadable.

GLB export of a scene as a *download* is not implemented; baking targets the
project, which is where a delivery is assembled.

---

## 6.5 The Asset editor document (Editor mode)

The `editor` workspace mode authors a **GLB asset** (a library part), not a
scene. It uses its own, deliberately separate op-log document — the
**AssetDocument** ([`src/core/editor/rv-asset-document.ts`](src/core/editor/rv-asset-document.ts)):

- **Ops** (`rv-asset-ops.ts`), fifteen kinds: `importCad`, `transformNode`,
  `renameNode`, `deleteNode`, `setNodeVisible`, `createNode`, `reparentNode`,
  `addComponent`, `removeComponent`, `setField`, `unsetField`, `setMaterial`,
  `separateMesh`, `mergeMesh`, `composite` — with undo/redo, coalescing and
  transactions. Note this is a **different** union from the scene op log
  (§2.1): the two documents share only `setField` / `unsetField` / `composite`
  by name. Structural
  deletes detach to a hidden trash group so undo re-attaches the original
  objects; CAD geometry is never inlined in ops (referenced by SHA-256, re-
  materialised via the private `CadGeometryProvider`).
- **Draft**: debounced autosave to IndexedDB (DB `rv-asset-editor`, store
  `drafts`, key `current`) — crash/forced-exit recovery replays the op log
  over the re-loaded base.
- **Save**: `GLTFExporter` bakes the live tree (geometry +
  `userData.realvirtual` incl. `CADLink`) into a binary GLB written to
  `<project>/library/Custom/<name>.glb` of the **active project** (+ thumbnail under
  `library/.thumbnails/Custom/`). The exporter writes `userData` into glTF
  `node.extras` — exactly the form the scene loader reads back, so the
  browser round-trip is symmetric. NOTE: Unity's exporter uses the
  `REALVIRTUAL` glTF extension form; browser-authored GLBs target the WEB
  loader.
- **Write-path seam**: the inspector routes through
  [`rv-edit-target.ts`](src/core/hmi/rv-edit-target.ts) — SceneStore ops
  outside the editor, AssetDocument ops inside. The editor never touches the
  `rv-scenes*` keyspace.

---

## 7. Auxiliary persisted stores

The Scene model is the heart of "what is the user editing", but realvirtual
persists a long tail of unrelated state. Most keys are declared **next to the
store that owns them**, not centrally: `rv-storage-keys.ts` carries the sweep
list `ALL_RV_STORAGE_KEYS` plus `RV_DYNAMIC_PREFIXES`, and a key that appears in
neither survives "Reset all" (§1, §9.1). The tables below are the inventory; the
"Owner" column is where the key is actually declared.

### 7.1 localStorage — settings & preferences

| Key | Owner | Purpose |
|---|---|---|
| `rv-visual-settings` | `visual-settings-store.ts` | Lighting mode, tone mapping, shadows, FOV, camera bookmarks, AO mode, antialias, shadow map size |
| `rv-search-settings` | `search-settings-store.ts` | Search/filter UI preferences |
| `rv-interface-settings` | `interfaces/interface-settings-store.ts` | WebSocket Realtime / ctrlX / MQTT / TwinCAT HMI configuration |
| `rv-multiuser-settings` | `multiuser-settings-store.ts` | Multiuser relay URL, user name/colour |
| `rv-group-visibility` | `group-visibility-store.ts` | Per-group visibility toggles (persisted across reload) |
| `rv-hmi-visible` | `hmi-visibility-store.ts` | HMI overlay show/hide |
| `rv-maintenance-progress` | `maintenance-progress-store.ts` | Maintenance step completion state |
| `rv-ai-bridge` | `mcp-bridge-plugin.ts` | MCP bridge configuration |
| `rv-debug` | `engine/rv-debug.ts` | Debug subsystem flags |
| `rv-extras-overlay` | `engine/rv-extras-overlay-store.ts` | Top-level extras overlay flag (legacy boot-path fallback) |
| `rv-webviewer-last-model` | `main.ts` | Last opened model URL — used only when `?scene=` is empty AND no active saved scene |
| `rv-webviewer-renderer` | `main.ts` | `'webgl'`, `'webgpu'` or `'webgpu-gl'` (internal TSL test path) — read on boot; unknown values fall back to `'webgl'` |
| `rv-welcome-dismissed` | `ButtonPanel.tsx` | One-shot welcome banner |
| `rv-gpu-warning-dismissed` | `GPUWarningBanner.tsx` | One-shot GPU warning banner |
| `rv-env-user-modified` | `environment-presets.ts` | Marks the env preset as user-edited |
| `rv-pipe-coloring-enabled` | `pipe-coloring-plugin.tsx` | Pipe coloring on/off |
| `rv-pu-mode-enabled` | `processing-unit-mode-plugin.tsx` | Processing unit mode on/off |
| `rv-unity-cloud-config` | (Unity Cloud) | Unity Cloud build endpoint |
| `rv-scenes-cleared-legacy` | Settings → "Clear legacy WebViewer data" | One-shot marker that legacy keys were swept |
| `rv-active-mode` | `core/rv-mode-manager.ts` | Last active workspace mode, restored on boot |

The five workspace modes registered in `main.ts`, in dropdown order — **Viewer**
(`viewer`), **HMI** (`hmi`), **DES** (`des`), **Planner** (`planner`),
**Editor** (`editor`, `runtime: 'detached'`). `rv-active-mode` stores the id;
`viewer.modes.restore('hmi')` reads it on boot, and `?mode=<id>` overrides it
for that load without writing. A locked mode (`lock()`) ignores both.

#### realvirtual CONNECT keys

None of these are in `ALL_RV_STORAGE_KEYS` except the last, and the three
dynamic families are **not** in `RV_DYNAMIC_PREFIXES` — so "Reset all" leaves
them behind, one stale entry per interface id.

| Key | Owner | Purpose |
|---|---|---|
| `rv-connect-url` | `connect-store.ts` | CONNECT gateway base URL. The default is **derived from the page origin** by `deriveDefaultGatewayUrl()`: a loopback `http(s)` origin *is* the gateway (worktree sessions run CONNECT on 15363/15365), anything else falls back to `FALLBACK_GATEWAY_URL` = `http://localhost:5100` |
| `rv-connect-user-connected` | `connect-store.ts:420` | Set once the user pressed **Connect** and it succeeded. The page-load auto-probe requires it before touching a local gateway from a hosted origin, so Chrome's Local Network Access prompt appears at most once — at the moment the user explicitly asked for the connection, never unprompted on a page load |
| `rv-connect-autoconnect-optout` | `connect-store.ts` | Set when the user disconnected explicitly; without it the boot probe would reconnect and "Disconnect" would read as a no-op. Cleared on every explicit connect attempt |
| `rv-connect-expanded-iface` | `ConnectPanel.tsx` | Which interface row is expanded |
| `rv-connect-filter:<ifaceId>` | `ConnectPanel.tsx` | Per-interface signal filter text (**dynamic**) |
| `rv-connect-collapsed:<ifaceId>` | `ConnectPanel.tsx` | Per-interface collapsed sections (**dynamic**) |
| `rv-connect-scroll:<ifaceId>` | `ConnectPanel.tsx` | Per-interface scroll offset (**dynamic**) |
| `rv-connect-panel-width` | `layout-constants.ts` | Docked CONNECT panel width |
| `rv-connect-embed-signal-hint-seen` | `rv-storage-keys.ts` | One-shot standalone signal-link hint (the one CONNECT key in the sweep list) |

### 7.2 localStorage — UI panel/inspector state

| Key | Owner | Purpose |
|---|---|---|
| `rv-extras-editor-width` | `rv-extras-editor.tsx` | Property editor docked width |
| `rv-extras-editor-open` | `rv-extras-editor.tsx` | Open/closed state |
| `rv-extras-editor-selected` | `rv-extras-editor.tsx` | Last-selected node path |
| `rv-hierarchy-expanded` | `rv-hierarchy-browser.tsx` | Tree-view expanded node set |
| `rv-hierarchy-type-filter` | `rv-hierarchy-browser.tsx` | Type filter chips |
| `rv-hierarchy-signal-sort` | `rv-hierarchy-browser.tsx` | Signal sort order |
| `rv-inspector-collapsed` | `rv-component-section.tsx` | Per-section collapsed state |
| `rv-inspector-consumed-only` | `rv-property-inspector.tsx` | Show only consumed properties toggle |
| `rv-inspector-detached` | `rv-property-inspector.tsx` | Inspector docked vs floating |
| `rv-left-panel-active` | `left-panel-manager.ts` | Active left panel id (mutually exclusive panels) |
| `rv-models-window-open` | `TopBar.tsx` | Models window open/closed state |

### 7.3 localStorage — Layout Planner

| Key | Purpose |
|---|---|
| `rv-layout-library-urls` | Catalog tab URLs (user-added; bundled URLs excluded) |
| `rv-layout-autosave` | **Legacy** single-slot autosave — migrated once to `rv-layouts/<id>` on boot, then removed |
| `rv-layout-grid-enabled` | Grid snap on/off |
| `rv-layout-grid-size` | Grid size in mm |
| `rv-layout-rotation-snap` | Rotation snap in degrees |
| `rv-layout-drop-to-surface` | Drop-to-surface mode |
| `rv-layout-bbox-snap-enabled` | Magnetic bbox snap on/off |
| `rv-layout-bbox-snap-mid` | MID-point bbox snap on/off |
| `rv-layout-bbox-snap-side` | Side-edge bbox snap on/off |
| `rv-layout-bbox-snap-tolerance` | Magnetic snap tolerance in mm |
| `rv-layout-show-neighbor-distances` | Show neighbor-distance hints |
| `rv-layout-neighbor-distance-max` | Max neighbor distance in mm |
| `rv-layout-snappoint-magnet-enabled` | Snap-point magnet toggle (default on) |
| `rv-layout-chain-mode-enabled` | Chain mode — paired assets follow as a rigid group (default on) |
| `rv-layout-doc-mode` | Documentation mode — datasheets on hover/selection |
| `rv-layout-active-tab` | Last-active catalog tab URL |
| `rv-layout-library-origins` | `url → LibraryOrigin` map for attached libraries |
| `rv-layout-signal-link-mode` | Signal-link authoring mode (`signal-link-mode-store.ts`) |
| `rv-snap-index-v2:<glbUrl>` | Per-asset snap index cache (dynamic; see doc-layout-planner.md §6.6) |
| `rv-layouts-index` | Layout meta index (legacy multi-layout registry, superseded by `rv-scenes-index`) |
| `rv-layouts/<id>` | Layout body (legacy) |

The legacy multi-layout registry (`rv-layouts/<id>`) is no longer the active
Scene container — saved scenes write to `rv-scenes/<id>` instead. The legacy
keys exist only so that pre-unification users don't lose their layouts on
upgrade. `migrateLegacyAutosave()` runs once on boot and is idempotent.

**Pending placements are runtime-only — deliberately absent from this table.**
A *pending placement* is a fully committed placement whose root node still
carries placeholder geometry while its GLB decodes (see
[doc-lifecycle.md](doc-lifecycle.md) §3.4). It has **no** persisted
representation anywhere:

- `PlacedComponent` carries `glbUrl` as a required field from the very first
  frame, so the record written at drop time is byte-identical to that of a
  finished placement. **A save while an asset is still loading therefore writes
  a fully valid layout** — the position, rotation and scale recorded are the
  placeholder's, and the swap does not change them (it re-centres the adopted
  children and re-asserts the root's Y, never the root's XZ).
- There is no `pending` field in the schema, no dedicated op kind, and **no
  guard anywhere in the persistence path**. Nothing has to wait for a decode and
  nothing has to be filtered out before writing.
- The runtime list lives in `LayoutStore.pendingPlacements` (`rv-layout-store.ts`),
  purely to drive the HMI status line. `setPendingPlacements()` writes no storage
  key, `serializeLayout()` does not read the field, and the settings bundle does
  not carry it. It follows the same in-memory pattern as `setThumbnailPending`,
  including the field-wise no-op guard that keeps the registry's per-generation
  notifications from re-rendering the planner UI.

A reload during a pending load therefore restores the placement through the
ordinary `addPlacement` → `placeFromRecord` path (§5), which awaits the GLB and
produces no placeholder. In practice that is fast: the bytes are usually already
in the Cache API bucket (§7.7) from the interrupted load.

### 7.4 localStorage — dynamic prefixes (one entry per resource)

These are listed as `RV_DYNAMIC_PREFIXES` in `rv-storage-keys.ts` so
`clearAllRVStorage()` can sweep them without enumerating every concrete key:

| Prefix | Per-resource value | Owner |
|---|---|---|
| `rv-extras-overlay:<glbName>` | `RVExtrasOverlay` JSON (legacy boot-path fallback) | `engine/rv-extras-overlay-store.ts` |
| `rv-extras-originals:<glbName>` | Pre-override values for "reset" (legacy) | Same |
| `rv-annotations-<modelHash>` | Per-model annotation list | `plugins/annotation-plugin.ts` |
| `rv-measurements-<modelHash>` | Per-model measurement list | `plugins/measurement-plugin.tsx` |
| `rv-panel-…` / `rv-panel-geo:…` | Floating chart/panel geometry | `ChartPanel.tsx` |
| `rv-order-…` | Order Manager per-order state | `plugins/order-manager-plugin.tsx` |
| `rv-camera-start:<modelKey>` | `ModelCameraStart` per model (also written through `setCamera` ops) | `core/hmi/camera-startpos-store.ts` |
| `rv-sig-unlock:<…>` | Per-signal write-unlock acknowledgement | signal write-gate |
| `rv-login-…` | Login Gate per-deployment auth state (when configured to use localStorage) | `plugins/login-gate-plugin.tsx` |
| `rv-layouts/<id>` | Legacy layout body — see 7.3 | `layout-registry.ts` |

Dynamic families that exist but are **not** in `RV_DYNAMIC_PREFIXES`, and
therefore leak past "Reset all": `rv-connect-filter:`, `rv-connect-collapsed:`,
`rv-connect-scroll:` (§7.1), `rv-snap-index-v2:` (library snap index),
`rv-project/browser/` (§3.6).

### 7.5 sessionStorage — tab-scoped

These intentionally clear when the tab closes:

| Key | Purpose | Owner |
|---|---|---|
| `rv-sensor-history` | Floating Sensor History panel layout (x, y, w, h, clamped to viewport on read) | `sensor-history-store.ts` |
| `rv-order-cart` | Order Manager cart (private session state) | `plugins/order-manager-plugin.tsx` |
| `rv-login-auth` (default key) | Login Gate authentication flag — defaults to sessionStorage so closing the tab forces re-auth | `plugins/login-gate-plugin.tsx` |

`ALL_RV_SESSION_STORAGE_KEYS` lists the first **two** for grep-ability
(`rv-login-auth` is configurable per deployment and is not in the array). None
of them are swept by `clearAllRVStorage()` — the browser already drops them on
tab close.

### 7.6 IndexedDB — `rv-filesystem`

[`src/core/engine/rv-local-filesystem.ts`](src/core/engine/rv-local-filesystem.ts)
stores `FileSystemDirectoryHandle`s in the `handles` object store. It is a
**multi-key** store, not a single slot:

| Handle key | Constant | What it points at |
|---|---|---|
| `workspace` | `HANDLE_KEY_WORKSPACE` | The workspace root that contains project folders |
| `projectfolder:<projectId>` | `handleKeyForProject(id)` | One project folder picked outside a workspace |
| `workfolder` | `HANDLE_KEY_WORKFOLDER` — **`@deprecated`** | The legacy single working folder, retired in favour of the project (plan-372). Kept so existing installs still resolve |

Handles survive reloads but the browser may prompt the user to re-grant
permission.

**Access is not read-only.** The two modes coexist deliberately:

- The legacy `workfolder` picker is still `mode: 'read'`, and
  `ensureWorkFolderPermission()` queries/requests `'read'` — a no-write path for
  the model selector.
- Project and workspace folders go through `selectFolderForKey()`, which picks
  with **`mode: 'readwrite'`**, and `ensureHandlePermission()` defaults to
  readwrite. This is what lets a project write models, library assets and the
  baked GLB of §6.1 back to disk. A separate upgrade path lifts an existing
  read-only handle to readwrite.

Companion key in localStorage: `rv-local-folders` carries
`{ displayName, lastAccessed }` so the Settings UI can show "Working folder:
MyProject (last opened …)" without forcing a permission prompt.

The folder is read by both the main model selector (`models/`) and the Layout
Planner (`library/`, optionally with category subfolders).

### 7.7 Cache API — `rv-planner-glbs`

`ModelCache` ([`plugins/layout-planner/model-cache.ts`](src/plugins/layout-planner/model-cache.ts))
uses the browser **Cache API** (named bucket `rv-planner-glbs`) as a
persistent network cache for catalog GLBs:

```
getOrLoad(url):
  if in-memory cache  → clone and return
  if Cache API hit    → load from blob, populate in-memory
  else                → fetch, cache.put(url, response), load from blob
```

This survives reload (unlike the in-memory `Map`) and means a heavy planner
catalog only downloads once per browser. `ModelCache.clearPersistentCache()`
deletes the bucket; otherwise it persists until the user clears site data.

### 7.8 Converted-CAD cache — OPFS + `rv-cad-glbs`

[`core/import/rv-cad-glb-cache.ts`](src/core/import/rv-cad-glb-cache.ts) stores
**converted GLB bytes** under the content hash of the *original* imported file:
`(sha256, quality) → GLB`.

This is the backbone of the GLB-first import pipeline. Every import — STEP, USD,
a `.glb` file, a catalog entry — is converted to GLB **once**, cached here, and
then *loaded from these bytes*. An `importCad` op in the AssetDocument carries
only `{Sha256, Quality}`, never geometry, so draft replay after a reload is a
byte read plus a `GLTFLoader.parse`: no occt, no WASM worker, no re-tessellation.

Two tiers, tried in this order:

| Tier | Location | Notes |
|------|----------|-------|
| 1. OPFS blob store | sha256-keyed, `core/storage/rv-opfs-blobs` | Tier 1 since plan-372 Phase 11 (§5.4). Effectively unbounded, available in Firefox and Safari too, and shared with the project blob store. |
| 2. Cache API | bucket `rv-cad-glbs` | Fallback when OPFS is unavailable. Byte-budgeted, LRU. |

`putCadGlb()` returns which tier accepted the bytes (`'opfs' | 'cache-api' |
'none'`).

> **Historic tier 1 — `<workfolder>/.cad-cache/`.** The `CAD_CACHE_FOLDER`
> constant is still exported but is `@deprecated`: nothing writes there any
> more. The working folder is being retired in favour of the project, and a
> content-addressed cache must not depend on which folder happens to be open.

> **The cache must never live under `library/`.** `listFiles` (rv-local-filesystem)
> recurses every subdirectory and filters only by extension, so cached GLBs there
> would surface as planner catalog entries. (`library/.thumbnails/` escapes this
> only because it holds `.png`.) Guarded by `tests/rv-cad-glb-cache.test.ts`.

Because the lookup lives in the **public core**, a public build — which has no
`CadGeometryProvider` at all — can reopen a draft containing STEP imports. The
provider is only needed to convert something *new*, or to `retessellate()` from
the original CAD bytes (private Cache-API bucket `rv-step-sources`) when the GLB
cache has been evicted. When neither can produce the geometry, replay raises
`CadGeometryUnavailableError`, which the asset editor surfaces as a re-import
prompt rather than logging it away.

`clearCadGlbCache()` wipes both tiers.

---

## 7.5 DES experiment & snapshot storage (chunked IndexedDB)

The DES workspace stores full simulation snapshots hierarchically —
**Model → Experiment → Replication (seed) → Snapshot(t)** — in a dedicated
IndexedDB database `rv-des-experiments` with two object stores:

| Store | Key (U+001F unit-separator delimited) | Value |
|-------|--------------------------|-------|
| `manifests` | `{model} {experiment}` | `ExperimentMeta` (replications, seeds, snapshot metas, `version` lock counter) |
| `blobs` | `{model} {experiment} {repl} {t}` | ONE full `DESSnapshot` (gzip via `CompressionStream` above 1 MB) |

Rules:

- **One record per snapshot** — never a whole experiment as one string
  (V8 `JSON.stringify` limit; structured clone is synchronous).
- The overview UI reads **only manifests**; blobs load on demand.
- Writes are atomic: blob + manifest update run in ONE multi-store
  readwrite transaction (blob put first); standalone manifest writes use
  optimistic locking (`ExperimentMeta.version` — stale writes throw and the
  caller re-reads and retries).
- **Export/import**: one experiment travels as an `NDJSON.gz` blob — a JSON
  header line (`{"format":"rv-des-experiment","formatVersion":1,"manifest":…}`)
  followed by one JSON line per snapshot, gzipped as a whole. Import renames
  on name collision.
- Generic helpers live in `src/core/persistence/`: `rv-idb-utils.ts`
  (promisified IndexedDB) and `rv-gzip-utils.ts` (CompressionStream gzip) —
  feature-agnostic, usable by any store.
- Browser storage is an evictable cache (Safari: 7-day eviction). The
  Experiments window shows the `navigator.storage.estimate()` usage and warns
  near quota; export is the durable path.

The public control surface is `SimDesControl` (string/primitive transport
only): `listExperiments`, `readManifestJson`, `saveSnapshot`, `loadSnapshot`,
`deleteSnapshot`, `deleteReplication`, `deleteExperiment`, `renameExperiment`,
`exportExperiment`, `importExperiment`, `estimateStorage`, `masterSeed` /
`setMasterSeed`. Replication *r* of an experiment runs with the derived seed
`baseSeed + r · 1000` (Unity parity). The `MasterSeed` field on the scene's
`DESManager` component (GLB-first) overrides the seed only when POSITIVE —
missing or `<= 0` keeps the engine default (42).

### 7.5.1 Simulation runs, projects & checkpoints

Simulation runs extend the same hierarchy — **a RUN is a REPLICATION** that
carries run metadata (`runId`, `status: completed | aborted`, wall-clock
start/end, reached sim time, a statistics aggregate), and **a CHECKPOINT is a
Snapshot(t)** labeled `auto`. There is no second storage system:

- **Projects** are the comparison boundary above experiments. They live in a
  small separate IndexedDB `rv-sim-projects` (store `projects`, public side);
  experiment manifests are tagged with `projectId` + `glbHash` (a SHA-256
  fingerprint of the material-flow structure). A changed model structure
  creates a NEW experiment under the SAME project; comparisons (multi-run
  charts, mean ± 95% CI) are strictly project-internal.
- **Archiving** happens in the DES manager's reset hook (covers native DES
  and the DESRunner) and on the sim-end completion edge — once per run. The
  archive resolves the replication by SEED: re-running the same seed
  overwrites its (deterministically identical) result; auto-seed mode rolls a
  fresh seed per reset and therefore creates a new replication. Retention
  prunes the oldest archived runs beyond `retentionMax` (blobs included).
- **Checkpoint autosave** writes a full snapshot on **grid-aligned sim
  times**: a neutral checkpoint system event is planned exactly onto every
  `autoSaveInterval` boundary (`n · interval` — 04:00:00, 05:00:00, … at a
  1 h interval; 0 = off, the default) in the DES event queue, with minimum
  priority so it fires after all time-equal model events — the snapshot
  carries the exact round sim time in every mode (Animated, FastForward,
  Step). The event is pure infrastructure: it is never counted in the model
  statistics, never serialized into snapshots, and is dropped when the model
  has no events left, so seeded runs stay bit-identical with autosave on or
  off. A wall-clock rate limit (so FastForward cannot flood the store) and a
  back-pressure guard only skip the SAVE at a boundary — the boundary chain
  always continues, and skipped boundaries are not made up. Changing the
  interval at runtime re-plans the next boundary immediately. A per-run ring
  buffer keeps the newest `checkpointMax` autosaves. Loading a checkpoint
  restores state + RNG streams, re-arms the boundary chain, and drops into
  Step mode for deterministic continue/debugging.
- **User preferences** (`seedMode fixed/auto`, autosave interval, ring size,
  retention, active project) persist in localStorage `rv.des-run-settings` —
  user-local, never scene state. The current seed itself IS scene state
  (`MasterSeed` field, op-log persisted).
- Facade additions on `SimDesControl`: `activeRunInfoJson()` and
  `patchExperimentMetaJson()` (JSON string transport, like the rest).

**UI**: ONE Experiments window
([`DESExperimentMatrixPanel`](src/plugins/sim-controller/DESExperimentMatrixPanel.tsx),
public) renders the whole hierarchy as a tree — project header (select /
new / rename / delete-cascade) above **Experiment → Run → Checkpoint** rows.
The UI consistently says *run* (replication stays a data-model term). Every
experiment of the active project is visible at once; run checkboxes across
the whole tree feed the compare view (`des-run-compare-store`). Experiment
rows carry snapshot-now / export / rename / delete; import + refresh sit in
the title bar; a bottom field creates a new experiment ("+ Snapshot into
it"). The loaded model is shown by NAME — the internal `glbHash` never
appears; experiments recorded with a different model version get a subtle
"other model version" chip. Both entry points (the "Experiments" button in
the DES clock settings and the DES side-tool button) toggle the same window
via `des-matrix-window-store.ts`.

---

## 8. Settings bundle — export/import + sidecar

[`rv-settings-bundle.ts`](src/core/hmi/rv-settings-bundle.ts) collects the
auxiliary stores (visual, interface, search, multiuser, group
visibility, per-model camera presets) into a single versioned JSON document:

```json
{
  "$schema": "rv-settings-bundle/1.0",
  "exportedAt": "2026-…",
  "modelUrl": "models/factory-demo.glb",
  "settings": {
    "visual": { … },
    "interface": { … },
    "cameraStart": { "<modelKey>": { px, py, pz, tx, ty, tz, duration? } }
  }
}
```

Three usage modes:

1. **Export** (Settings → Backup → Export) — writes
   `<modelBasename>.settings.json`.
2. **Import** (Settings → Backup → Import) — validates schema, prompts
   confirmation, then applies via `applySettingsBundle()` which merges with
   current values (`{ ...current, ...bundle }`).
3. **Sidecar auto-load** — on first visit (when `rv-visual-settings` is
   absent), `loadModelSettingsConfig(modelUrl)` fetches
   `<modelUrl>.settings.json` from the same path. Silent on any error —
   never blocks model loading. This is how a deploy can ship per-model
   default settings.

The bundle does **not** include the Scene model, drafts, layouts, or any
`rv-scenes/*` data. Scenes are exported/imported separately via
`exportSceneJSON` / `importSceneJSON`.

---

## 9. The "Reset all" and "Clear legacy" tools

Settings → **Backup** ([`src/core/hmi/settings/ModelTab.tsx`](src/core/hmi/settings/ModelTab.tsx))
offers:

| Button | Calls | Effect |
|---|---|---|
| **Reset all** | `clearAllRVStorage()` then reload | Sweeps every `ALL_RV_STORAGE_KEYS` entry + every key matching `RV_DYNAMIC_PREFIXES`. Does NOT touch sessionStorage (the browser does that on tab close). Does NOT touch IndexedDB, OPFS, or any key missing from both lists (§1, §9.1). Hidden when settings are locked. |
| **Clear legacy WebViewer data** | Removes `rv-layouts-index`, `rv-layouts/*`, `rv-scene-active`, `rv-layout-autosave`, `rv-layout-library-urls`, `rv-extras-overlay:*`, `rv-extras-originals:*`. Sets `rv-scenes-cleared-legacy = true`. Reloads. | Reclaims quota from pre-unification keys without dropping the user's current Scene store |
| **Clear CAD import cache (N MB)** | `clearCadGlbCache()` | Wipes both converted-CAD tiers (§7.8). Parts re-convert on the next import; scene layouts are unaffected. The button shows the measured size. |
| **Withdraw analytics consent** | `resetAnalyticsConsent()` | GDPR withdrawal. Shown only when a tracker is configured (`isAnalyticsConfigured()`) and consent was given. |
| **Export / Import settings** | `collectSettingsBundle` / `applySettingsBundle` | See §8 |

The legacy button is only shown if `listLegacyWebViewerKeys()` finds at
least one entry — so users who never had pre-unification data don't see it.

### 9.1 What "Reset all" does **not** touch

`RV_DYNAMIC_PREFIXES` does **not** include `'rv-scenes/'`, so
`clearAllRVStorage()` leaves the following intact by design:

- `rv-scenes-index` and every `rv-scenes/<id>` saved scene
- Both autosave snapshot slots (`rv-scenes/draft/<base>`, `rv-scenes/scene-draft/<id>`)
- `rv-scenes/active`

This is intentional — "Reset all" is meant to wipe **settings**, not user
content. If you change it (e.g. add `'rv-scenes/'` to the prefix list), you
will delete the user's saved scenes on click. Most users expect Settings to
be separate from their saved work; preserve that boundary.

`ALL_RV_STORAGE_KEYS` also contains two historical entries that are no
longer written by the live code: `'rv-scene-active'` (singular, replaced by
the slashed `rv-scenes/active` form) and `'rv-splat-transform'` (legacy
transform store, superseded by `PlacedComponent` ops). They stay in the
sweep list so that older browsers still get cleaned up.

---

## 10. Quota and failure handling

localStorage is bounded (typically 5–10 MB per origin). Every write is
wrapped in `try/catch` and silently ignored on `QuotaExceededError`. The
SceneStore comment for `writeIndex` is representative:

```ts
try { localStorage.setItem(LS_KEY_INDEX, JSON.stringify(sorted)); }
catch { /* Quota — caller surfaces toast. */ }
```

**The seam for surfacing that failure now exists** (plan-372 §5.1), in
[`rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts):

```ts
export interface SceneStorageError {
  op: 'write-scene' | 'write-index' | 'write-draft';
  id?: string;          // scene id, where one is known
  cause: unknown;
}

onSceneStorageError(listener): () => void   // subscribe
getLastSceneStorageError(): SceneStorageError | null   // or poll
clearLastSceneStorageError(): void
```

`reportStorageError()` is called from every swallowed `setItem` failure. The
return contract of `writeScene()` / `writeIndex()` is deliberately unchanged —
announcing on this channel is additive, and a bad listener cannot break a save.

**Subscriber count is currently zero.** User-visible behaviour is therefore
still exactly as before: the write is dropped and nothing is shown. What
changed is that a toast layer no longer has to be threaded through every write
path — it only has to call `onSceneStorageError()`.

The op log cap (`MAX_OP_HISTORY = 500`) is the primary defense against
runaway growth.

**Thumbnails (`thumbnailDataUrl`)** are stored as base64 PNG data URLs
inside the `RvScene` record and are the largest single contributor to
per-scene size. They are generated lazily on `save()` / `saveAs()` (not on
every op) by rendering a small framebuffer of the current viewer. There is
no explicit thumbnail-clear API — the only ways to drop a thumbnail are to
delete the scene, overwrite it with a fresh save, or clear localStorage.
A typical thumbnail is 10–40 KB; 100 saved scenes with thumbnails fit
comfortably within the 5 MB quota, but a thousand will not.

If you're adding a new persisted store, **do not hand-roll the try/catch**. A
bare `localStorage.setItem` bypasses the settings lock, so a locked deployment
(kiosk, `?perf`, customer build) would still write user preferences. Use the
canonical helpers in
[`src/core/hmi/ls-store-utils.ts`](src/core/hmi/ls-store-utils.ts):

```ts
import { lsLoad, lsSave } from './ls-store-utils';

const KEY = 'rv-my-thing';
const DEFAULTS: MyThing = { … };

const loaded = lsLoad(KEY, DEFAULTS);  // merge over defaults, never throws
lsSave(KEY, value);                    // no-op when isSettingsLocked()
```

`lsSave()` guards on `isSettingsLocked()` and swallows quota/SecurityError.
`lsLoad()` merges the stored object over `defaults` and returns a defensive
clone; corrupted entries fall back to `defaults`. Its options bag takes
`migrate`, `validate` and `configOverride` for schema bumps, field-level
cleanup, and `appConfig`-driven overrides. For a single scalar flag, follow the
`createPersistedBoolStore(key, default)` pattern in
[`visual-settings-store.ts`](src/core/hmi/visual-settings-store.ts) instead of
writing a store by hand.

Then register the key in
[`rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts) — a dynamic family in
`RV_DYNAMIC_PREFIXES`, a fixed key in `ALL_RV_STORAGE_KEYS` — or "Reset all"
will not see it (§1).

---

## 11. Quick reference — what survives what

| Action | localStorage | sessionStorage | IndexedDB | Cache API | URL | In-memory |
|---|---|---|---|---|---|---|
| Page reload (same tab) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Close + reopen tab | ✅ | ❌ | ✅ | ✅ | only if bookmarked | ❌ |
| Browser restart | ✅ | ❌ | ✅ | ✅ | only if bookmarked | ❌ |
| Site data cleared | ❌ | ❌ | ❌ | ❌ | unaffected | ❌ |
| Settings → Reset all | ❌ | ✅ (browser will drop on close) | ✅ | ✅ | ✅ | depends on reload |
| Settings → Clear legacy | partial (legacy keys only) | ✅ | ✅ | ✅ | ✅ | depends on reload |

**On reload**, the SceneStore boot path (§4) restores:

- The active working scene (saved scene resumed from per-saved-scene
  autosave snapshot, or fresh built-in resumed from per-base autosave
  snapshot)
- All settings (visual, interface, etc.)
- Catalog tabs and grid preferences in the Layout Planner
- Per-model camera presets (and so the camera start animation)
- Annotations, measurements, group visibility toggles
- Working-folder handle (subject to a permission re-grant)
- Cached planner GLBs (no re-download)

What is **not** restored on reload:

- The simulation runtime state (signals, drive positions, MUs in transit) —
  recreated by the ops log on top of the freshly loaded GLB
- The undo/redo stacks — only the op log itself survives, so the user can
  undo back to the persisted baseline but not before it
- Floating-panel positions — the comment in `rv-settings-bundle.ts` is the
  canonical statement: "panel positions are no longer persisted; each panel
  re-anchors to the user's last click on open"
- The *pending* (or failed) state of a Layout-Planner placement whose GLB was
  still loading — the placement record itself survives and replays through
  `placeFromRecord`, which awaits the GLB (§7.3)

---

## 12. Where to look in the code

Heart of the persistence logic:

| File | Concern |
|---|---|
| [`src/core/hmi/scene/scene-store.ts`](src/core/hmi/scene/scene-store.ts) | `SceneStore` — workspace lifecycle, op queue, transactions, autosave timer |
| [`src/core/hmi/scene/rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts) | Pure CRUD over the five Scene keyspaces |
| [`src/core/hmi/scene/rv-scene-types.ts`](src/core/hmi/scene/rv-scene-types.ts) | `RvScene`, `SceneBase`, dirty detection, `materialise` |
| [`src/core/hmi/scene/rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts) | Op taxonomy, materialise, coalescing, inverse helpers |
| [`src/core/hmi/scene/rv-scene-executors.ts`](src/core/hmi/scene/rv-scene-executors.ts) | Forward + inverse executors against the live RVViewer scene |
| [`src/core/hmi/rv-storage-keys.ts`](src/core/hmi/rv-storage-keys.ts) | Central registry of all keys + `clearAllRVStorage()` |
| [`src/core/hmi/rv-settings-bundle.ts`](src/core/hmi/rv-settings-bundle.ts) | Settings export/import + per-model sidecar auto-load |
| [`src/core/hmi/ls-store-utils.ts`](src/core/hmi/ls-store-utils.ts) | `lsLoad` / `lsSave` — the canonical localStorage helpers (settings-lock aware) |
| [`src/core/project/`](src/core/project/) | Project subsystem: backends (folder / browser / bundled), migration, `rv-project/*` keys (§3.6) |
| [`src/core/rv-mode-manager.ts`](src/core/rv-mode-manager.ts) | Workspace modes + `rv-active-mode` persistence |
| [`src/core/engine/rv-local-filesystem.ts`](src/core/engine/rv-local-filesystem.ts) | IndexedDB-backed directory-handle store (workspace / project / legacy workfolder) |
| [`src/plugins/layout-planner/model-cache.ts`](src/plugins/layout-planner/model-cache.ts) | Cache API-backed planner GLB cache |
| [`src/core/hmi/camera-startpos-store.ts`](src/core/hmi/camera-startpos-store.ts) | `rv-camera-start:<modelKey>` per-model camera preset (storage backend of the `setCamera` op) |
| [`src/core/hmi/scene/SceneActiveCard.tsx`](src/core/hmi/scene/SceneActiveCard.tsx) | UI for Save / Save as… / Discard / Undo / Redo |
| [`src/main.ts`](src/main.ts) | Boot path: URL routing → SceneStore → fallback chain |

For a deeper dive into the Scene model design rationale (why the op log,
why two autosave slots, why composites can't nest), the inline doc comments
in `rv-scene-edits.ts` and `scene-store.ts` are the authoritative source —
they were written as the unified Scene plan was being implemented and
explain the trade-offs that aren't visible from the code alone.

---

## 13. Known limits and non-goals

This is the short list of things the persistence layer **does not** do.
They are intentional simplifications — read them before adding a feature
that assumes the opposite.

### 13.1 Cross-tab concurrency

There is no `BroadcastChannel`, no `storage`-event listener, no inter-tab
lock. Two tabs editing the same saved scene will silently race: each tab
writes its own autosave snapshot every 2 s, and whichever tab writes last
wins. The next reload sees that tab's state.

For single-user, single-tab editing this is the right default. For
collaborative workflows, use **Multiuser mode** (relay-based, see
`doc-multiuser-system.md`) — do not assume two tabs on the same machine
can co-edit safely.

### 13.2 Secrets at rest

`rv-interface-settings` stores PLC connection credentials (WebSocket auth
tokens, MQTT username/password) in **plain text** in localStorage. The
Login Gate plugin uses base64 obfuscation, which is not encryption. Treat
realvirtual WEB's localStorage as readable by anyone with file-system access
to the browser profile.

Production deployments that need real secret handling should:
- terminate auth at a reverse proxy (HTTPS + bearer token outside the
  browser), or
- use short-lived tokens fetched at runtime, never stored in localStorage.

### 13.3 Schema migration

`RvScene.schemaVersion` is `2` today. The validator rejects anything other
than `2` outright — there is no automatic v1 → v2 path. Importing an older
JSON returns `null` from `readScene()` and the user sees an empty
workspace. If you bump the version, add a migrator inside
`rv-scene-storage.ts:readScene()` rather than at every call site.

`migrateLegacyAutosave()` is the one existing migration (legacy
`rv-layout-autosave` single-slot → `rv-layouts/<id>` registry). Use it as
the template.

### 13.4 Multiuser session state

Avatar position, camera ray, voice/chat state, and the operator-camera
follow flag are **not** persisted. They are in-memory only and reset on
reload. Only `rv-multiuser-settings` (relay URL, user name, user colour)
survives, because it's a preference, not a session.

The interaction between Shared View mode and the local SceneStore is
deliberate: live signals and operator-camera updates **override** local
ops/camera, immediately and without blending, but they do not write into
the op log. Closing the shared view restores the local working scene.

### 13.5 Offline mode and Service Workers

The Cache API bucket `rv-planner-glbs` (§7.7) is the only network cache.
There is no Service Worker, no offline-first behaviour, and model GLBs
are not cached unless they came through `ModelCache`. A reload without
network connectivity will show an empty Models panel except for whatever
is already in the Cache API.

### 13.6 Atomicity of multi-key writes

`writeScene()` writes the body (`rv-scenes/<id>`) before the index
(`rv-scenes-index`). If localStorage hits quota between the two writes,
the result is an orphan body without an index entry — harmless for the UI
(it won't list) but it consumes quota until "Clear legacy" or "Reset all"
runs. There is no transaction primitive; if you add cross-key invariants,
plan for the partial-write case.
