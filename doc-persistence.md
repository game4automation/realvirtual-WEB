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
| **IndexedDB** (`rv-filesystem`) | `FileSystemDirectoryHandle` for a project / workspace folder (plus the retired working-folder slot, §7.6) | ✅ | ✅ | Project close / `removeWorkFolder()` |
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

## 1.4 Where the bytes come from — the three asset roots

Everything above is about state the BROWSER keeps. The GLB bytes themselves
come from disk, and there are exactly three roots they can come from. They are
not interchangeable, and the difference is what does or does not reach a
customer:

| Root | Contents | Served in dev as | Deployed? |
|---|---|---|---|
| `public/demo-realvirtual/` | **The demo PROJECT** (plan-737): its `project.json` plus every document that manifest declares. One folder, delivered unchanged to every channel; a GLB here that the manifest does not declare is invisible, not a "dev built-in" | `/demo-realvirtual/<file>` | yes |
| `public/library/` | **The component library — app-level**, one copy per installation, beside the demo rather than inside it (the delivered standard library: `PalletHandling` + `catalog.json`). Reached through a manifest `libraries[]` subscription, never through the demo backend base path | `/library/...` | yes |
| `../realvirtual-WebViewer-Private~/projects/<name>/` | Customer and internal projects. `projects/Development/` is the **internal** one: `fixtures/`, `models/`, `library/Custom/`, `scratch/` | `/private-assets/<project>/<path...>` | only on a private deploy of that project |

The third root is why `public/models/` can be small. Before plan-395 it held
45 MB of test fixtures, experiments and NDA-covered geometry — not out of
carelessness, but because no other place existed. `projects/Development/` is
that place, and `scratch/` inside it is the one for experiments.

The `/private-assets/` route is recursive and serves any project subfolder, so
it is also the one place where a path from a URL becomes a path on disk. Its
containment rules live in `scripts/_rv-private-assets.mjs` and are tested by
`tests/private-asset-route.node.test.ts`: a traversal there would read a
**customer** project, since every one of them is a sibling under the same root.

> The dev server binds all interfaces (`host: true`), so these paths are
> reachable from the network, not only from loopback. That predates plan-395
> and is plan-414's subject; plan-395 fixed the containment, not the exposure.

---

## 1.5 What is persisted, when, where — at a glance

This table is the cheat-sheet. Every persisted piece of state is described
later in this document, but the most common question is "**when does each
thing actually get written?**".

| What | Where | **Write trigger** | Read trigger |
|---|---|---|---|
| **Working-scene body** (autosave snapshot) | **GLB body slot** `draft/<baseKey>` or `draft/<sceneId>` (OPFS / project backend, §3.1b) | Every op application, **debounced 2000 ms** (`DRAFT_AUTOSAVE_DEBOUNCE_MS`, `scene-store.ts:1537-1580` → `_autosaveBody()`) | `openScene(id)` / `openBuiltin(url)` / `openEmpty()` at boot, via `_resolveLoad()` |
| ~~Working-scene op log~~ | ~~`localStorage rv-scenes/draft/<base>`, `rv-scenes/scene-draft/<id>`~~ | **DEAD since plan-397 phase 7 / plan-413 phase 6** — no writer, no reader (§3.1c, §3.1 table). Only the clear helpers still touch these keys. | — |
| **GLB-node signal bindings** (`kind: 'node'`) | Working-scene `setField` op: `SignalLinks.Mappings` | Every bind, unbind, or confirmed mapping edit | Scene replay / model load via `SignalBindPlugin` |
| **Placement signal bindings** (`kind: 'placed'`) | `PlacedComponent.signalMappings` inside the placement record | Every bind/unbind — written straight through `LayoutStore.updateSignalMappings()`, **no** `setField` op | With the placement, on `addPlacement` replay |
| **Saved document** (a row in the project) | project file `scenes/<name>.glb` + a `documents[]` row | **Explicit user action**: Save / Save as… / Duplicate / Import / Rename | `openDocument(id)` |
| **Active-scene pointer** | `localStorage rv-scenes/active` | `save()` / `openScene()`; cleared when opening an unsaved built-in | Boot fallback when `?scene=` is missing |
| **URL `?scene=…`** | History API (no storage) | Every workspace switch via `history.replaceState` | Boot, on every reload |
| **Visual / interface / search / multiuser settings** | `localStorage rv-<area>-settings` | **Every setter call** in the respective store (no debounce — synchronous) | Lazy on first access |
| **Per-group visibility** | `localStorage rv-group-visibility` | On every visibility toggle | Scene/model load + UI mount |
| **Per-model camera preset** | `localStorage rv-camera-start:<modelKey>` | `saveStartPos()` / `clearStartPos()` (also via `setCamera` op) | `scene-loaded` event |
| **Per-model annotations / measurements** | `localStorage rv-annotations-<hash>` / `rv-measurements-<hash>` | On create / edit / delete | Model load |
| **Layout Planner UI state** (grid, snaps, tabs, library URLs) | `localStorage rv-layout-…` | On every toggle / value change | Planner panel mount |
| **Planner active library** | `localStorage rv-planner-active-library` | Every library pick in the Library window's dropdown | Planner panel mount, **before** the store's own `activeTabUrl` |
| **Hierarchy / Inspector / panel UI state** | `localStorage rv-hierarchy-… / rv-inspector-… / rv-extras-editor-…` | On every UI change (expand, resize, select) | Panel mount |
| **User plugin overrides** (which plugins are switched off) | `localStorage rv-plugin-overrides/<scope>` — scope = project id, else model key (plan-435) | Every feature-matrix toggle, via the `plugins-changed` event with `kind: 'user-disabled' \| 'user-enabled'` | Boot, after the last `viewer.use()` and **before** the model load |
| **Project / workspace folder handle** | `IndexedDB rv-filesystem` | On user folder selection | Project open / resume |
| **Folder display name** | `localStorage rv-local-folders` | Same call that writes the IDB handle | Settings UI render |
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

2b. **One row can make the viewer look broken after a reload: the plugin
   overrides.** A plugin switched off in the feature matrix stays off across
   reloads, so a missing button is not necessarily a bug. Two guards keep this
   recoverable: `core: true` and protected plugins are never persisted or
   applied, and `?resetPlugins=1` wipes every scope before any of them is read.
   The prefix is listed in `RV_DYNAMIC_PREFIXES`, so "Reset all" clears it too.

3. **One row of this table has no write trigger at all: a transient workspace.**
   An Example or a shared link is fully editable and persists *nothing* — by
   design, so that opening somebody's link cannot write itself into your
   profile. That makes "unsaved" mean something different there than everywhere
   else, which is why the product distinguishes `hasUnsavedWork()` from
   `hasUnpersistedWork()`, marks the state, guards the unload, and offers a save
   that converts the workspace. See §3.5a for the suppression and **§3.5c** for
   the vocabulary.

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

A `SignalMapping` carries eleven fields — `kind`, `componentPath`, `slot`,
`sourceKind`, `signal`, `interfaceId`, `topic`, `direction`, `enabled`, plus the
two plan-425 anchors `carrierSignalName` and `componentType` (below). Legacy
records omit the optional ones; every read site normalizes `sourceKind` through
`mappingSourceKind()` (`?? 'connect'`).

#### Surviving a model change (plan-425)

Both anchors above exist because a binding is addressed by PATH and a Unity
re-parent rewrites paths. They are written at bind time, never inferred later,
and a mapping that lacks one keeps exactly the pre-425 behaviour.

**`carrierSignalName` — the node the mapping SITS on.** Written only when the
carrier is itself a registered PLC signal whose name is unambiguous
(`isDuplicateSignalName` is the same fail-closed rule plan-418 uses). The
resolution runs in the overlay scan, not in the model traverse: a `setField` op
whose path is dead is never materialised onto any node, so the traverse cannot
read the anchor in the one case it exists for. `planCarrierMigrations()`
(`orphaned-bindings.ts`) reads the payload straight out of the overlay, resolves
`store.getPath(name)`, and migrates the op as a **transactional pair** —
`setField` at the new path AND `unsetField` at the old one. The `unsetField` half
is not bookkeeping: without it the stale op survives and the same orphan is
rediscovered on the next load.

**`componentType` — the slot the mapping POINTS at.** The resolver has always
known the type and never persisted it, which left a moved slot mapping with an
under-determined key. With it stored, `applyMappings()` runs a second pass on a
first-pass miss (`findRepairCandidate`, `rv-binding-repair.ts`): same type, same
slot, same sanitisation-normalised leaf name. Exactly one match produces a repair
CANDIDATE — never an automatic rebind, because Three.js deduplicates node names
per file (`X` vs `X_1`) and a leaf comparison can therefore present the wrong
node as the single obvious answer. Zero, several, or a legacy mapping without the
field stay orphaned. `applyMappings()` also no longer drops unresolvable mappings
silently: they are recorded and readable via `getUnresolvedMappings()`.

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

## 2. The document model

> **Since plan-397 a saved scene is a GLB file. Since plan-413 so is
> everything else, and they are all the same kind of thing: a document.** The
> op log did not go away — it is still how an edit is made, undone and redone —
> but it is no longer what gets *stored*. This section describes both halves,
> because both are live: the op log in memory, and the GLB on disk.

### 2.0-00 One document model — the scene catalogue is gone (plan-716)

Read this before anything below that says "catalogue row". Since plan-716 there
is exactly **one** thing a user can own: a **GLB document** with a row in the
project manifest's `documents[]`. The parallel world — the `rv-scenes/*`
localStorage catalogue, `scn_` ids, the id-keyed OPFS bodies — is not a second
kind of content any more. It is a **legacy keyspace being read**.

**What that means concretely.**

| Was | Is |
|---|---|
| `newSceneId()` minted `scn_<time>_<rand>` | **deleted.** No code path mints a scene id. `tests/scene-removal-guard.test.ts` fails if one comes back |
| `SceneStore.listScenes()` / `listBuiltins()` | **deleted.** Documents come from `documentsOf(project)`; built-in SOURCES come from `builtinSources(viewer)` in `rv-model-catalog.ts` |
| `ProjectBackend.listScenes()` on all three backends | **deleted.** `listDocuments()` is the one listing; the row's `path` says which folder holds it |
| `mergeSceneTiers` / `forkSceneEntry` / `TieredSceneEntry` | **deleted.** `mergeDocumentTiers` is the one merge |
| `ProjectSnapshot.scenes` / `sceneIds`, `getProjectScenes()`, `getProjectSceneIds()` | **deleted.** The snapshot carries `documents[]` |
| `createEmpty` / `duplicate` / `delete` fell back to a catalogue row | **document ops only.** They throw when the id names no document, or when there is no writable project |
| `rename` wrote `rv-scenes/<id>` | writes the **manifest row**. `name` and `path` are separate fields, so this is a display rename; moving the file is the tree's `applyTreeMove` |
| "Add example to My Scenes" minted a `scn_` row | **materialises a document** through the same create seam as *New* and *Save as…* |

**What deliberately survives, and why.** Three readers still touch
`rv-scenes/*`, and each is pinned by name in the removal guard so that a fourth
has to be a decision somebody makes:

1. **The eager migration** (`rv-workspace-migration.ts`, §3.1d) — it has to read
   the old rows to convert them.
2. **The folder-project scene cache** — `ProjectStore.hydrateScene()` mirrors a
   folder scene into `rv-scenes/<id>`, and `rv-project-conflict.ts` compares the
   two on the next open. That is the documented *never a silent overwrite* net.
   It outlives plan-716 on purpose: the comparison is **content-based**
   (`scenesEqual`, ignoring timestamps), and re-expressing it over document
   revisions alone would be *weaker* — a recorded revision says which folder body
   the cache was filled **from**, not what it holds **now**. Rows of this kind
   carry `readSceneOwner(id).cachedFrom`, which is exactly why the migration
   skips them.
3. **The active-id pointer** (`readActiveId()`), which resolves through the
   permanent alias map and therefore answers with a `documentId`.

**The `scn_` prefix is permanent as a read.** Strip regexes, the alias map, the
retired namespace and the migration's own filter all still recognise it. An old
`?scene=scn_…` link must keep resolving forever; only minting is forbidden.

#### Migration (`rv-scenes/*` → documents)

Runs **once, eagerly**, awaited inside `resolveActiveProject()` — so before
`initSceneStore()` and before `?scene=` routing, which is what guarantees the
alias map exists when the router needs it. One tab at a time
(`navigator.locks`, `rv-migration-716`), with a progress overlay. Per row:

```
resolveDocumentAlias(scn_X)?  ─ yes ─> skip b–d (already converted)
  b. read body            (null and no alias ⇒ a row that never had one)
  c. write document       writeDocument(scenes/<name>.glb, { expectedRevision: 'create' })
  d. write alias          scn_X → <documentId>   ← FAILS ⇒ abort this row, do NOT retire
  e. rename draft slot    draft/<scn_X> → draft/<documentId>     ← always runs
  f. retire the old body  rv-scenes-retired/glb/<scn_X>          ← always runs
```

`e` and `f` run even when the alias already exists, because a crash between `d`
and `e` would otherwise be skipped forever rather than healed. The marker
(`rv-migration/scenes-v1`) is written **last**. Bodies with no row are recovered
as `Recovered <id>` documents rather than dropped.

#### The retired namespace, and how to go back

Nothing is hard-deleted. A converted row's bytes move to:

```
rv-scenes-retired/row/<sceneId>     the RvScene record
rv-scenes-retired/glb/<sceneId>     the OPFS body pointer
```

Purging that namespace is a **later release**, deliberately not this one — it is
the only copy a downgrade has.

**Downgrade is not automatic.** A previous version does not know the retired
prefix, so it sees an empty catalogue. Restoring is a prefix rename, and it is
safe to run: it only touches keys under `rv-scenes-retired/`. Paste into
DevTools *before* installing the older build:

```js
// Restore the pre-plan-716 scene catalogue from the retired namespace.
const index = [];
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k?.startsWith('rv-scenes-retired/row/')) {
    const id = k.slice('rv-scenes-retired/row/'.length);
    const row = localStorage.getItem(k);
    localStorage.setItem('rv-scenes/' + id, row);
    const meta = JSON.parse(row);
    index.push({
      id: meta.id, name: meta.name,
      createdAt: meta.createdAt, modifiedAt: meta.modifiedAt,
      baseKind: meta.base?.kind, baseLabel: meta.base?.label,
    });
  }
  if (k?.startsWith('rv-scenes-retired/glb/')) {
    localStorage.setItem(
      'rv-scene-glb/' + k.slice('rv-scenes-retired/glb/'.length),
      localStorage.getItem(k),
    );
  }
}
localStorage.setItem('rv-scenes-index', JSON.stringify(index));
localStorage.removeItem('rv-migration/scenes-v1');   // let it convert again later
console.log('restored', index.length, 'scenes');
```

`listRetiredKeys()` (exported from `rv-workspace-migration.ts`) enumerates the
namespace if you want to inspect it first. There is deliberately **no purge
verb** in the product yet — only `__resetWorkspaceMigrationForTests()`, which is
what its name says. Adding one is the follow-up this section exists to make
safe to schedule.

The documents the migration produced are **left alone** by the snippet: after a
restore the same content exists twice, once as a document and once as a
catalogue row. That is the safe direction — the alternative is a restore that
can lose work — and re-running the newer build converges it again, because the
alias pre-check recognises what it has already done.

### 2.0-0b One document I/O protocol, and the end of `section` (plan-736)

The type distinction was gone; the *storage* distinction was not. Until plan-736
a document's manifest row carried `section: 'scenes' | 'models' | 'library'`, and
exactly one place read it to decide **which write protocol** the bytes went
through: a `scenes` row used `readScene`/`writeScene` with a compare-and-swap, and
everything else used `readBlobUrl`/`writeBlob` without one. The field was stored
rather than derived because the path prefix is wrong on the browser backend, where
a scene's path is its bare id.

**The backend surface now.** One read, one write, one delete, one URL:

| Method | Replaces | Note |
|---|---|---|
| `readDocument(ref)` → `DocumentRecord` | `readScene` + `readBlobBytes` | bytes **+ manifest meta + revision**, for every document |
| `writeDocument(ref, bytes, { expectedRevision })` | `writeScene` + `writeBlob` | the precondition is **mandatory** |
| `deleteDocument(ref)` | `deleteScene` + `deleteBlob` | tolerant: a missing body is the desired end state |
| `readDocumentUrl(ref)` | `readBlobUrl` | kept — a glTF with external buffers needs a base URL |

`expectedRevision` is required and has three spellings: a **revision** ("I read
this and am replacing it"), `'create'` ("this must not exist yet"), and `'any'`
(a deliberate unconditional overwrite). There is no way to omit it. That does not
make an `'any'` write safer by itself — it makes each one *state* which of the
three it is, which turns a missing precondition from an invisible default into a
reviewable line. Every `'any'` in this tree carries a comment saying why.

**Where the routing went.** Into the backends, where it is a private detail of
what each one stores. The browser backend keeps scene bodies in the GLB store
(`rv-scene-glb/<id>` + OPFS) and everything else in the path-keyed blob index, and
it chooses between them by asking its own stores — an id with a pointer *is* a
scene body — plus, for a brand-new scene that has no pointer yet, the `meta` the
caller passes in the `DocRef`. That is caller intent at the call site, not a
persisted category: nothing stores it and nothing can disagree with it later.

**`statDocuments()` is body-authoritative.** It enumerates *both* browser stores.
This is the load-bearing part: the adopt/orphan scan quarantines and eventually
deletes a row whose body it cannot see, and a blob-only stat list made every
browser scene look missing. `section === 'scenes'` was the guard standing between
that and data loss — so the guard could only be removed once the hole was closed
at its source. `tests/document-predicate-equivalence.test.ts` is the measurement.

**`section` is never removed from a manifest.** It is gone from
`RvDocumentEntry`, nothing stamps it, and the demo manifest carries none. But a
delivered `project.json` that has one keeps it forever: unknown fields ride
through `isValidProjectV1` and `mergeManifest`'s read-modify-write untouched
(`tests/section-passthrough.test.ts`). Reading one is the business of the legacy
layer at the top of `rv-project-documents.ts` and of nothing else.

**One transitional exception.** `documentOfSceneEntry` (and its Node twin in
`scripts/_rv-manifest.mjs`) still stamps `section: 'scenes'` on a browser scene
row. An OLD client meeting a section-less bare-id scene would run it through the
pre-plan-736 path heuristic, get `'library'`, and route it down the blob branch —
a storage failure, not a badge. Removing the stamp is a separate step, gated on
the slow delivery channels (ctrlX snap, CONNECT-embedded appliances) shipping a
client that no longer reads the field. The first section-less row written into a
user's browser storage is the point of no return.

**For MCP callers.** The file/document tools report `folder` — the first path
segment, `''` at the project root. `section` survives as a deprecated alias
carrying the identical value for one release.

### 2.0-0 One content type: the document

A project used to have three: a **model** you opened, a **scene** you edited and
a **library asset** you referenced. Since plan-397 those are literally the same
bytes — a GLB — and the only surviving difference lived in the editing layer
above. That is a *role*, not a type, and plan-413 collapsed the three into one:

| Term | What it means now |
|---|---|
| **Document** | The one content type: a GLB with an identity (`id`), a classification and a revision. |
| **DocumentLevel** | The fixed structural step a document declares about itself: `part`, `assembly`, `plant`, `scene` (§3.7). |
| **Scene** / **Asset** | **Roles**, not types. "Scene" is a document you open; "asset" is one you reference. The same file can be both, and **asset** is the word the UI uses. |
| **Reference** | A document placed inside another one (`AssetReference` in the parent's GLB, plus an `AssetOverrides` merge patch for the values the parent changed). References nest recursively, up to `MAX_REFERENCE_DEPTH = 16` per composition. |
| **Section** | Which surface holds a document's bytes — `scenes`, `models` or `library`. It decides *how* the bytes are read and written, not *what* the document is. |

Consequences that show up throughout the rest of this document:

- the project manifest carries **one** `documents[]` list (§3.6), not three
  arrays;
- what a document *is* travels **inside the GLB** (§3.7); the manifest and the
  library sidecar are caches of that, and the file always wins;
- a document can be **copied or moved between sources** (§3.10) without losing
  the identity every reference hangs off;
- **no mode restricts which document may be open** — a mode selects the verbs on
  offer, not the file (§2.1a, and doc-webviewer.md → *Workspace Modes*);
- the word "model" is gone from the user interface. It survives in some
  internal identifiers (`openModel()`, `models/`) where renaming would have
  meant a repo-wide sweep for no behavioural gain.

#### What a holdout gets now (plan-413 phase 6, F10)

The pre-397 JSON scene world is **gone** — reader included. `.scene.json`
bodies, `RvScene` with `schemaVersion: 2`, the two draft keyspaces, the
op-log→GLB migrator and the manifest's three legacy arrays: none of it has a
code path left. What remains is one error and one sentence, in
[`rv-legacy-format.ts`](src/core/project/rv-legacy-format.ts):

> This project was saved in a format that is no longer supported (…).
> Open it once with realvirtual WEB **6.3.16** — the release before this one —
> to convert it, then open it here again.

Three surfaces can meet a holdout, and all three raise the same
`LegacyFormatError` at the **entrance** of the read rather than partway through
it:

| What is still stored | Where it is caught | What the user sees |
|---|---|---|
| a manifest scene row pointing at `.scene.json`, or declaring the old body format | `readManifest()` | the project does not open at all |
| a `.scene.json` path handed to a backend directly | `readScene()` on folder / browser / bundled | the scene does not open |
| `rv-scenes/<id>` still carrying a `schemaVersion: 2` op log | `readScene()` in `rv-scene-storage` | that scene does not open |

The refusal is deliberately **total**, not per-entry. A project that opened with
two of its five scenes and no explanation is a project the user would save over,
and the sixth save would be the one that made the loss permanent. The cost of
the strict reading is one release of friction for anybody who skipped the
conversion window; the cost of the lenient one is silent data loss.

Two things are explicitly *not* affected, because they were never the op-log
world: the **v3 catalogue row** at `rv-scenes/<id>` (base plus empty ops — a
directory entry, not a body) and the **`rv-scene-glb` store** that holds the
bytes. §3.1 has the final keyspace table.

### 2.0-0a What a reference override carries (plan-444)

The `AssetOverrides` block on a reference node is the parent file's entire say
over the asset below it. It holds **three sibling maps**, not one
([`rv-asset-reference.ts`](src/core/engine/rv-asset-reference.ts)):

| Field | Key | Value | Who writes it |
|---|---|---|---|
| `byNodeId` | `NodeId` inside the referenced file | `ComponentPatch` — componentType → field → value, `null` deletes (RFC 7396) | every field edit made inside a reference |
| `byPath` | path relative to the reference node | the same `ComponentPatch` | nothing any more — a read-side bridge for files written before NodeIds existed |
| `trsByNodeId` | `NodeId` inside the referenced file | `TrsOverride` — optional `position` / `quaternion` / `scale`, glTF-native LOCAL TRS of the target node in the referenced file's own frame | the bake, for a node of a referenced asset the user moved |

**`trsByNodeId` is a sibling of `byNodeId`, never a key inside it**, and that is
a correctness rule rather than a layout preference. `byNodeId[nodeId]` **is** the
flat componentType → fields map, so a `trs` key living in there would be handed
to `applyComponentPatch` as a *component type* and written into the target's
`extras.realvirtual.trs` — a fake component in every file we save. A sibling
field is invisible to the patch path by construction, which is what makes the
addition genuinely additive.

A transform needed a block of its own because it is **glTF-native data on
`nodes[i]`**, not an `extras.realvirtual` component: no shape inside a component
patch could carry it. Until plan-444 a moved node of a referenced asset was
therefore refused outright, which made "import a STEP, drag a part into place,
save" impossible.

Every field is optional and independent — an override that only moves a part
leaves the rotation and scale the asset authored. The routed bake in fact writes
`position` and `quaternion` only: `NodeTransformEntry` carries no scale, the
referenced asset owns its own (a GLB node may carry a mirror scale), and a save
that invented one would change geometry the user never touched.

#### The level rule: the first reference level, and no deeper

A transform override lives on the **reference node of the file being written**.
`writeNodeLevel` (category 5,
[`rv-scene-glb-bake.ts`](src/core/hmi/scene/rv-scene-glb-bake.ts)) decides which
of three outcomes applies exactly the way category 1 decides it for fields — by
where the node lives:

| Where the moved node lives | What the bake writes |
|---|---|
| the file being saved | glTF-native TRS on `nodes[i]`, as it always was (`transforms`) |
| a referenced asset whose reference node is in this file | `AssetOverrides.trsByNodeId` on that reference node (`referenceTransforms`) |
| a referenced asset that is itself referenced from another referenced asset | **refused** — `UnwritableTransformError` |

The nested case stays a refusal because the reference node that would have to
hold the override does not live in the file we may write. Writing into the
referenced asset instead is what the user ruled out — it would move the part in
every other instance too — and dropping the move quietly is what F9 exists to
prevent. The error names the way out (open the referenced asset and move the
part there, or undo the move), because `SaveDialogs.tsx` renders that reason
verbatim. `BakeResult` counts the two writable outcomes separately, so
`referenceTransforms` says how many moves left the file as overrides rather than
as native TRS.

#### Round-trip

Move → save → reload → the part is where it was left.

- **Write.** `materialise` keys `nodeTransforms` by node path, so the array
  reaching the bake is already coalesced to the FINAL TRS per node; merging is
  last-write-wins per NodeId. Moving one part ten times leaves one entry, not a
  history — the file states the current position, the same rule the root-file
  branch follows.
- **Carry-through.** `getAssetOverrides` / `setAssetOverrides` are the one
  read-modify-write pair, and both halves carry `trsByNodeId`. So does
  `writeOverride` ([`rv-reference-guard.ts`](src/core/ops/rv-reference-guard.ts)),
  which is that same pattern: a block missing there would mean any later field
  edit on any node of the asset silently drops the moved part's position.
- **Read.** `applyAssetOverrides` applies the component patches first and the
  transforms **last** — a patch must never be able to overwrite the position the
  user dragged a part to — and only by `NodeId` (see the `byPath` note in
  [doc-node-paths.md](doc-node-paths.md) §1). Composition then refreshes
  `matrixWorld` on the grafted subtree once, and only when
  `transformsApplied > 0`: bounds, auto-align and the first raycast all read it
  and none of them waits for a render.
- **Old files load unchanged.** The field is absent in everything written before
  it existed, and absent means "no override". Parsing is defensive and per
  FIELD, not all-or-nothing: a malformed rotation must not throw away a
  perfectly good position written by the same save. A quaternion of length ~0 is
  rejected (normalising it would invent a rotation), and a scale component below
  `1e-6` is rejected rather than clamped — a zero scale makes `matrixWorld`
  singular and poisons every later picking test with NaNs. An entry left with
  nothing usable is dropped, and a block left empty reads as absent.
- A node whose ONLY override is a transform still has overrides:
  `getAssetOverrides` counts all three blocks. Answering `null` there is what
  would make the compose hook skip the block and the moved part snap back.

#### An orphaned transform reads as a hole in the layout

A `trsByNodeId` entry whose NodeId no longer exists in the asset is collected
like any other orphan — `applyAssetOverrides` RETURNS them, composition carries
them up as `orphanedOverrides` and the load result hands them to the
non-blocking status row; none of it is logged away. But a transform orphan gets
its own `addressing: 'trs'` and its own sentence:

```
moved part → node "a1b2c3d4" no longer exists in asset "…"
 — its saved position was dropped
```

It is kept apart from `'nodeId'` deliberately. The two orphan for the same
reason and read completely differently to a user: "Drive.TargetSpeed no longer
has a target" is a setting that will not apply, "the part you moved is gone" is
a hole in the layout. One shared label would have described neither.

### 2.0 What a scene is now

```
┌─────────────────────────────────────────────────────────────────────┐
│                            RvScene                                  │
│  id, name, createdAt, modifiedAt, schemaVersion: 3                  │
│  base:  { kind: 'builtin'; url; label }                             │
│       | { kind: 'empty' }                                           │
│       | { kind: 'scene-glb'; sceneId; label; revision? }   ← v3     │
│  edits:                                                             │
│    ops:      [ RvOp, … ]     ← EMPTY in v3: the ops are in the file │
│    settings: { catalogUrls, gridSizeMm }                            │
└─────────────────────────────────────────────────────────────────────┘
```

| schemaVersion | What the record IS |
|---|---|
| **2** | the **body**: `edits.ops` was the persisted form (pre-397). **Not readable any more** — it raises the F10 error above |
| **3** | a **catalogue row**: the body is the GLB the base points at, `edits.ops` is empty. The only version written *and* the only one read |

A `scene-glb` base names a **scene id**, not a URL. That is deliberate: a
`blob:` URL dies with the document while the record outlives it, and a
project-relative path is wrong for a user with no project. Resolving the id to
bytes is the storage layer's job
([`rv-scene-glb-io.ts`](src/core/hmi/scene/rv-scene-glb-io.ts)).

### 2.0a Where the bytes go — the one rule

The decision log says the bodies live in **OPFS + the project folder**, and
which applies depends on what is open:

- a **writable** `ProjectBackend` (folder or browser project) owns the scene →
  `writeScene()`, and the body travels with the folder;
- otherwise → the project-independent `rv-scene-glb` store (OPFS, keyed by
  scene id).

The second branch is not an edge case. `resolveActiveProject()` always ends
with *some* backend, but its last fallback is the **bundled** one, and that is
`writable = false` with a `writeScene()` that throws — so a user who never
opened a project would have had every save rejected. Both branches are GLB-only
and both carry the same compare-and-swap revision (a SHA-256 of the stored
bytes), so callers never have to know which one they got.

### 2.0a-1 Saving: one rule, two cases (plan-719)

Everything above answers *where* the bytes go. This answers *what the user
experiences*, and since plan-719 it is two sentences:

1. **A document saves to its own path, silently.** No dialog, ever — in either
   lineage, from the Save button, Ctrl+S, the exit guard or MCP.
2. **A read-only source** (`providerAsset`, `builtinModel`, a `referencedAsset`
   with no path of its own) shows exactly **one** "Save into project as…"
   prompt. Confirming it creates a document through `createDocument()` and
   writes into that — after which rule 1 applies forever.

There is no third case. In particular there is no longer a base kind `'empty'`:
"New asset" creates a real document (bytes + manifest row) the moment it is
asked for, so no document ever has to invent a home at its first save. That
removal is guarded by `tests/asset-empty-removal-guard.test.ts`.

**Drafts written before this release** can still carry `shell.base =
{kind:'empty'}`. `migrateLegacyEmptyDraft()` (`rv-asset-draft-storage.ts`)
converts such a record into a real document BEFORE the op replay, rebasing the
draft slot onto the result so a second recovery binds instead of creating a
second document. Without a writable project it returns `null`, the record is
left untouched and the user is told — never a silent discard.

**Failures** show one dialog with the concrete reason plus a `.glb` download
fallback (`askSaveProblem`). The pre-716 "Cannot save to Custom library" text,
which dropped the reason its caller had already computed, is gone.

The three save dialogs live in the public core (`core/hmi/scene/
save-dialog-store.ts` + `SaveDialogs.tsx`) even though plan-434 privatised the
editor UI: they are document infrastructure, not authoring, and both tiers must
answer these questions identically. The store owns **one pending name prompt per
document** — a second request while one is open answers the `SAVE_PROMPT_BUSY`
sentinel — which is what makes the double-click guard cover every entry point
rather than only the one that happens to call `saveDocument()` first.

**After every successful document write** `viewer.emit('document-saved',
{documentId, relPath})` fires. Caches keyed on document bytes (the layout
planner's decoded models) hang off that event; before it, invalidation was done
by the save flow reaching into the planner and matching `library/**`, so a
document saved under `models/` was placed from stale bytes afterwards.

### 2.0a-2 Authored manifests: the demo project (plan-726)

Almost every manifest in this system is *written by the app*. `public/project.json`
is the exception: it is authored by hand, checked in, and shipped to the deploy
root, where `BundledBackend.readManifest()` reads it. It defines the
DemoRealvirtual project (`id: prj_sample`) for every channel at once — the hosted
demo, the CONNECT community download and the dev checkout.

Two rules apply to any authored manifest, and both are enforced by tests:

- **Document ids MUST be `stableDocumentId(path)`.** That function is what mints
  the ids everywhere else, and `openDocument()` writes them straight into the
  address bar as `?doc=<id>`. Those links are already in circulation, so a
  hand-picked literal here would send every one of them to
  `reportMissingDocument()`. Derive the id from the path; never invent one.
- **`settings.defaultModel` must name a document the manifest actually has.**
  It is matched by `findStartDocument()` — exact path, then id, then a *unique*
  file name. The lenient third branch exists for five delivered customer
  manifests that carry a bare filename against a `models/`-prefixed path; it
  refuses an ambiguous name rather than guessing.

The demo project is **read-only** — `BundledBackend` is HTTP, there is nothing to
write to — so a save from it takes case 2 of §2.0a-1 above: one "Save into
project as…" prompt, and the copy lands in the writable *My Workspace* project.
The visitor keeps their edit; the demo stays what it was for the next visitor.

A manifest that is missing, unparseable or invalid under `isValidProjectV2()`
falls back to the synthesized demo project **and logs a warning**. The demo
still loads — the failure is visible in the console rather than as a white page.

### 2.0b Why the op log still exists

It is the edit mechanism, not the storage format:

- `applyOp` / `undo` / `redo` / transactions / coalescing are unchanged;
- **undo does not survive a reload** — a deliberate, user-accepted loss: a
  loaded GLB comes back with an empty op log, because the ops are folded in;
- the debounced autosave bakes the **whole** op log onto the **same** unchanged
  base bytes every time, which is what makes repeated saves deterministic
  rather than cumulative — nothing is ever applied twice, because the source
  never carries the previous result.

`materialise(ops)` produces seven categories, and `bakeIntoGlb()`
([`rv-scene-glb-bake.ts`](src/core/hmi/scene/rv-scene-glb-bake.ts)) writes all
seven into the file. Before plan-397 the writer persisted exactly one of them.

See [`src/core/hmi/scene/rv-scene-types.ts`](src/core/hmi/scene/rv-scene-types.ts)
and [`src/core/hmi/scene/rv-scene-edits.ts`](src/core/hmi/scene/rv-scene-edits.ts).

### 2.1 Edit operations

Every user edit produces an immutable op record, and there is **one** op
vocabulary for all of them:
[`rv-unified-ops.ts`](src/core/ops/rv-unified-ops.ts), **25 primitive kinds plus
`composite`** for transactions. Scene editing and asset authoring are two
*origins* within that one union, not two documents — see §2.1a.

Ops written against a **scene** (an overlay on top of a base GLB):

| Kind | What it does | Inverse via |
|---|---|---|
| `addPlacement` | Spawn a planner-catalog object (Layout Planner) | `removePlacement` of same id |
| `removePlacement` | Remove a planner placement | Re-`addPlacement` carrying the snapshot |
| `transformPlacement` | Move/rotate/scale a placement | `prev.{position,rotation,scale}` |
| `setCamera` | Set or clear the per-scene camera start preset | `prev` preset |
| `setCode` | Set or clear the scene's authored script code | `prev` code |
| `addNode` | Create a new node under an existing parent (e.g. an inserted IK path waypoint); carries a component-bearing `NodeSpec` | `removeNode` with the same node path |
| `removeNode` | Remove a node created by an `addNode` op; carries the full spec so undo can re-create it | Re-`addNode` from the snapshot |
| `addConnection` | Add a connection edge (plan-259), applied additively on top of the GLB-authored `Connections` block | `removeConnection` of the same edge |
| `removeConnection` | Remove a connection edge | Re-`addConnection` from the snapshot |
| `setConnectionType` | Define or redefine a user connection-type signature | `prev` signature, or `removeConnectionType` when there was none |
| `removeConnectionType` | Drop a user connection-type signature | Re-`setConnectionType` from the snapshot |

#### What identifies a placement across a reload

`PlacedComponent` carries both a `catalogId` and a `glbUrl`, and only the first
one is an identity. A `blob:` URL is dead the moment the page reloads, so
`resolvePlacementUrl` (`plugins/layout-planner/planner-persistence.ts`)
re-resolves every placement by `catalogId` before the restore places it:

| `catalogId` prefix | How the source is recovered |
|---|---|
| *(none — a catalog id)* | The saved `glbUrl` when it is stable, else the current catalog entry. A bundled `library/…` path is re-rooted onto this deploy's `BASE_URL`, so a scene authored on `/` still resolves under `/demo/`. |
| `local-…` | The catalog entry's FRESH blob URL, produced by the boot-time folder scan. |
| `unity-cloud:…` | A fresh download through the Asset Manager extension (`cloud.downloadGlb`). |
| `project:<path>` | The library registry (plan-723). The document has no stable URL at all: the planner loads it under the stable cache key `resolved:<providerId>:<sourceId>:<entryId>`, and `resolvePlacementUrl` only *probes* that it is still readable — it resolves, releases the handle immediately and returns the `catalogId` as a marker. `glbUrl` stays empty for these placements and is never written back. |

The function **never throws**, whatever a backend does: the first restore loop
has no `try`/`catch` around the call, so a rejection there would abort the whole
restore and silently drop every later placement. An unrecoverable placement
returns `null`, which the loop logs and skips — except for virtual/DES
placements, which have no source URL by construction.

Ops written against an **asset** (the authored GLB itself):

| Kind | What it does | Inverse via |
|---|---|---|
| `importCad` | Graft a converted CAD subtree in; geometry is referenced by SHA-256, never inlined in the op | Detach the imported subtree |
| `renameNode` | Rename a node | `prev` name |
| `deleteNode` | Delete **any** subtree; carries only the path | The original objects, re-attached from the trash group |
| `setNodeVisible` | Show/hide a node | `prev` visibility |
| `createNode` | Create an empty `Object3D` with a deduplicated name | Detach to the trash group `create:<opId>` |
| `reparentNode` | Move a node to a new parent | `prev` parent + sibling index |
| `addComponent` | Add an rv-ODT component block to a node | `removeComponent` of the same type |
| `removeComponent` | Remove a component block | Re-`addComponent` from the snapshot |
| `setMaterial` | Assign a material to a mesh | `prev` material |
| `separateMesh` | Split one mesh into its connected parts (§ *Mesh Separator* in doc-webviewer.md) | Re-merge from the snapshot |
| `mergeMesh` | Collapse a subtree back into one mesh | Re-separate from the snapshot |

Ops that belong to **both** origins:

| Kind | What it does | Inverse via |
|---|---|---|
| `setField` | Set `userData.realvirtual[componentType][fieldName] = value` on a node | `prev` (or `unsetField` if `prev === undefined`) |
| `unsetField` | Remove an override and restore the GLB default | `prev` value |
| `transformNode` | Move/rotate/(scale) a node. `transform.scale` is **optional**, and its presence — not the document's mode — decides the executor path: absent ⇒ the frozen-safe position/quaternion path that never writes `node.scale`; present ⇒ full TRS. `[1,1,1]` is never substituted, because Unity-exported nodes ship mirror scales that must survive | `prev` transform, same rule |
| `composite` | Group several primitives into one undo unit (composites do not nest) | Each child inverse, in reverse order |

Every primitive op carries its own inverse (`prev` field) so undo never
re-runs the forward executors against missing or stale state. Composites are
flattened recursively when materializing.

`RV_OP_ORIGIN` in the same module records the origin of every kind as data, and
`rv-op-semantics-pinning.test.ts` pins it: a kind that quietly changes lineage
changes which executor it reaches.

### 2.1a One document class, one op log

`SceneStore` and `AssetDocument` are **facades**. Each holds one
[`RvDocument`](src/core/ops/rv-document.ts) — the single class that owns the op
log, the undo floor, the redo stack, the single-flight queue, transactions,
coalescing, the history cap and dirty derivation. The two facades keep their
public APIs and their own op *construction* and persistence; the mechanics
below them are one implementation, parameterised by an `RvDocumentMode`
(`'scene'` or `'asset'`) that the executor routes on.

Since plan-710 there is **one vocabulary, not two bridged by a cast**. Ops are
constructed as `RvOp` at the source, executors take `RvOp` subtypes, and the
legacy type names (`EditOp`, `PrimitiveEditOp`, `CompositeOp`, `AssetOp`,
`AssetPrimitiveOp`, `AssetCompositeOp`) and the whole `rv-op-upcast.ts` layer
are **deleted** — every apply used to cross the two vocabularies through an
up-/downcast, and every read of the op log paid an O(n) downcast of the entire
array. A log persisted by an older build stays readable: it is renamed once,
where it enters the session (`normalizePersistedSceneOps` in
`SceneStore._installOps`), not on every apply.

Three kinds looked shared before the merge and only two payloads were:
`addNode`/`createNode` and
`removeNode`/`deleteNode` stayed **separate** kinds, because neither pair can
express the other without loss (different payloads, different construction,
different undo — spec-rebuild vs. trash-group re-attach).

Because there is one log, a document can also be **stacked**: descending into a
referenced asset pushes a frame with its own document, and the parent's log
survives the round trip untouched (§2.1b).

### 2.1b The document stack

A descend does not swap the open document, it **pushes** one.
[`RvDocumentStack`](src/core/ops/rv-document-stack.ts) holds a frame per level:
the asset, its op log, its dirty bit, and the **occurrence chain** it was
entered through. The breadcrumb is that chain — `occurrenceSegments(occurrence)`
is the address, not a second structure derived from it (see
[doc-node-paths.md](doc-node-paths.md) §1).

- **Frame identity is per frame, never per asset id.** Composition is a DAG, so
  the same asset may legitimately sit in the stack twice; two frames of one
  asset are two op logs, two dirty bits, two undo stacks. When the lower frame
  saves, the upper one is stale and is treated on pop like an externally changed
  document rather than silently edited on.
- **Undo is per frame.** An undo in the child can never reach the parent.
- **Back re-loads the parent in full** from its bytes and replays its op log
  (`RECOMPOSE_STRATEGY = 'full-parent-reload'`,
  [`rv-document-recompose.ts`](src/core/ops/rv-document-recompose.ts)). The
  incremental alternative was measured and rejected: `traverseAndRegister` only
  adds, so a grafted subtree leaves ghost paths in the registry, and both
  `buildGroups` and the `driveNodeSet` classification construct singletons with
  no incremental merge path. The full reload is the normal load path, so it buys
  every phase literally.
- **Isolation is the parent's property.** A child loaded from its own bytes is
  the whole viewport, so it isolates nothing; on pop the restored frame calls
  `isolateNodes` again with its own roots (the viewer has exactly one isolation
  slot), and an empty stack calls `exitIsolate()`.

### 2.1c One instance, two projections (plan-711)

A descend pushes a frame; a **mode switch does not push anything**. When the
editor opens the document the scene is already showing, the two do not run two
documents side by side any more — they share the one `RvDocument` instance, so
the op log, the undo/redo stacks, the clean point and `dirty` are literally the
same objects on both sides of the switch.

**Same document is a decided question, not a guess.** `sameDocumentBase(a, b)`
([`active-asset-store.ts`](src/core/editor/active-asset-store.ts)) compares kind
plus the key fields of that kind, exactly, never heuristically: a false negative
costs continuity the user could have had (the pre-711 save/restore path, still
fully supported), a false positive would put one file's op log on another file's
bytes. Saved scenes became comparable at all through the `sceneDocument`
identity, which `SceneStore._loadIntoWorkspace` records for every open.

**The instance is handed over, never looked up.** `SceneStore.beginProjection-
Handover()` returns the living document together with the two things the editor
cannot produce for itself — the scene as BYTES, and the way back. There is no
"base → document" map anywhere; the doctrine in
[`rv-document-stack.ts`](src/core/ops/rv-document-stack.ts) still holds, and
descend frames stay independent.

**A mode switch is a RECOMPOSE**, not a second load:
`captureHistory` → rebuild the tree → replay onto it *without recording* →
`restoreHistory`. That is the pattern Descend/Back established, generalised into
[`rv-document-projection.ts`](src/core/ops/rv-document-projection.ts) as the one
implementation with one lock scope (`runExclusive` covers the reload too).

**The replay is FILTERED by projection**, and that is a correctness rule rather
than an optimisation. `resolveOpTarget` routes by op ORIGIN and only four kinds
(`composite`, `setField`, `transformNode`, `unsetField`) follow the mode. An
unfiltered replay does not skip the foreign ops — it runs them against the wrong
tree: a scene `addPlacement` in the editor projection reaches the scene executor,
finds no layout planner and is swallowed into a warning; an asset `deleteNode`
in the scene projection deletes a node out of the scene. Everything that cannot
materialise through `applyForward` crosses over as BYTES instead — the scene's
ops through the bake (which is what writes placement reference nodes), the
editor's through the authored-tree export.

| Direction | Tree comes from | Replay |
|---|---|---|
| scene → editor | the scene's bake (`bakeBytes()`) | asset-projected ops only |
| editor → scene | the authored tree, exported and adopted as the new bake source | none — those bytes ARE both halves |

Four consequences worth knowing:

- **Undo across the seam is KIND-triggered.** `needsRecomposeToUndo(op, mode)`
  is asked *before* anything is applied, because a foreign inverse does not
  fail — the scene executor swallows it, the common asset kinds do
  `if (!node) return`, the log pops either way and nothing reports a thing. Such
  an undo re-projects the log without the op (`undoViaRecompose`), and is
  refused (not queued) while the document is busy or inside a transaction.
- **Tree-bound executor state is dropped at the switch.** `adoptAssetContext`
  installs a FRESH `AssetExecutorContext`: `_trash`/`_trashGroup` hold
  references into the replaced tree, and restoring from them re-registers a
  detached subtree whose path then shadows the real node. Ops whose inverse
  depended on it are re-projected instead — the same machinery as above.
- **Discard means discard.** A bound document records `bindFloor = opCount`, and
  discarding rolls the ops above it back for real (`rollbackTo`, under
  `runExclusive`). `markSaved({floor})` would have REBASED the clean point onto
  them, i.e. handed the work the user threw away to the scene as a saved state.
- **The scene's body autosave is suspended** for the duration and flushed on
  return, with the authored bytes as the new bake source. It bakes
  `materialise(ops)` against `viewer.registry`, and in the editor projection
  both are wrong at once. `hasUnpersistedWork()` keeps answering true while the
  work is owed, so no new tab-close window opens.

`RvDocument.setProjection(mode)` moves both mode fields — the document's (which
drives composite tagging and the snapshot) and the unified executor's (which
drives `resolveOpTarget`) — so they can never disagree, and
`doc.executor === AssetDocument.executor` survives the binding (pinned by
`tests/executor-identity-pinning.test.ts`).

### 2.2 The op queue, transactions, and coalescing

`RvDocument` serializes all op application through a single-flight async
queue:

```
applyOp ─┐
         ├─► _enqueue ─► await applyForward(op) ─► _pushOp ─► debounced autosave
undo ────┤              await applyInverse(op)
redo ────┘
```

- **No concurrency**: ops apply one at a time. `addPlacement` (which loads a
  GLB) cannot interleave with a `setField`.
- **In-flight loads**: the owner supplies a `canApply` gate, and ops that arrive
  while it is closed are dropped. `SceneStore` closes it for the duration of
  `openScene` / `openBuiltin` / `newEmpty` — the load itself is replaying the
  canonical state and any user input would race against it.
- **Transactions**: `beginTransaction(label)` + `endTransaction()` wraps a
  sequence of primitives into one composite op. Forward applies happen
  immediately on each primitive (so the live scene reflects each step), but
  only one entry lands on the history → one undo reverts the whole gesture.
  `withTransaction(label, fn)` is the RAII helper. Transactions are
  **all-or-nothing**: a primitive that throws rolls the already-applied ones
  back in reverse order and nothing lands on the history. Nesting folds into the
  outermost transaction, which is the only one that commits.
- **Failure is observable**: a failed op is survivable for the document *and*
  visible to its caller — the queue tail keeps running, and the caller's promise
  rejects.
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

## 3. localStorage layout for the document model

### 3.0 Vocabulary — three concepts at the workspace level

To avoid confusion, this document uses three precise terms instead of the
overloaded word "draft":

| Term | What it is | Where it lives |
|---|---|---|
| **Working scene** | The live editing session — an op log on top of a built-in or empty base. The Inspector, Hierarchy and Planner all act on this. | `SceneStore._workspace` (in-memory) + autosave snapshot (GLB body slot) |
| **Autosave snapshot** | A debounced backup of the working scene. The reload-survival mechanism — nothing more. Since plan-397 phase 6/7 it is a **baked GLB body**, not an op log: `_afterOpsChanged()` (`scene-store.ts:1537-1580`) debounces 2000 ms and calls `_autosaveBody()`, which writes the slot from `_bodySlots()` (`scene-store.ts:793-798`). | GLB body slot `draft/<baseKey>` (unsaved workspace) or `draft/<sceneId>` (saved scene with unsaved edits) — §3.1b. **Not** localStorage. |
| **Saved document** | A named, persistent GLB file with a `documents[]` row. Created by Save / Save as… / Duplicate / Import. Since plan-716 the ONLY kind of owned content — the `rv-scenes/*` catalogue it replaced is a legacy keyspace being read (§2.0-00). | a project GLB (root-level, `models/…` or `library/…` — the folder is a place, not a type) + manifest row |

The document list in the UI is the set of saved documents — it is **not** a
view onto the autosave snapshots. Editing a built-in stays in the autosave
snapshot only; it never becomes a document until the user explicitly saves it
into the project.

### Examples are documents (plan-731)

There is **one catalogue**. An "Example" — a curated demo scene shipped with the
build — is an ordinary `documents[]` row of `public/project.json`, and it is
opened by `openDocument()` like every other document. Its preferred workspace
mode (e.g. `planner`) is a property of the row (`mode`), applied on open unless
`?mode=` overrides it.

The demo's examples sit at the project ROOT, so no folder identifies them and
(since plan-736) no `section` field does either. What says an example is a scene
is `classification.level: "scene"` — a statement about what the document IS,
whose truth lives in the GLB's own root extras and whose manifest copy is a
cache of it (§2.5). The two Node guards that select them
(`bake-published-scenes`, `published-examples-glb`) read that, and re-read the
GLB in the same test, so cache and file are checked against each other.

Until plan-731 they were a **second identity space**: a curated
`public/scenes/index.json` (`[{ file, name, mode }]`) discovered at boot by
`discoverPublishedScenes()`, addressed as `published:<urlName>` rather than by
document id, opened by `SceneStore.openPublishedExample()` into a TRANSIENT
workspace, and made permanent by a `materializePublishedExample()` verb that
existed only to turn one into a real document. Seven independent consumers read
that space, among them a hard-coded `?scene=published:DemoPlanner` literal in
the Welcome modal's planner button.

All of it is gone. What remains is an **alias**: `rv-published-scenes.ts` maps a
legacy `published:<urlName>` token onto the document whose path carries that
basename, and the boot then follows the ordinary `?doc=` path and normalises the
address bar. The mapping is derived from the manifest, never stored — a
`published:` link is a link a stranger clicks in a fresh browser.

What the read-only behaviour was really about survives as a property of the ROW:
a bundled-tier document is read-only, and saving one forks it through the
ordinary `saveAs`/`duplicate` verbs.

**Repo fixtures** — demo content that must never reach a customer — carry
`devOnly: true` on their row. Every staging path prunes on that field (file and
row alike), and `assertManifestResolves()` refuses a channel whose output still
declares one. Before plan-731 the rule was a filename convention (`Test*` under
`dist/scenes/`) that the manifest could not express and no gate could verify.

The demo documents reach a deploy only through the public demo profile:
`copyCore(…, { includePublicDemoContent })` in
[`scripts/_workspace-lib.mjs`](scripts/_workspace-lib.mjs) excludes the demo
content **and** `public/aasx/` from the copied source tree unless the deploy is
the public core demo. A customer workspace never receives the files at all, so
nothing has to be deleted from `dist/` afterwards.

Public deploys go one step further: `bunny-deploy.mjs` prunes every document
the manifest marks `devOnly: true` — file **and** manifest row — so dev fixtures
never reach the demo, wherever in the deploy the file sits. The old filename
rule (`Test*` under `dist/scenes/`, prefix configurable via
`RV_PUBLIC_TEST_SCENE_PREFIX`) survives underneath it as the answer for a
`dist/` built from a source tree that has no `devOnly` anywhere; its pattern
still matches the old `.scene.json` spelling as well as `.glb`, which costs
nothing when the file is not there and would leak a fixture if dropped.

This is why the UI shows two buttons (the authoritative description of the rule
behind them is §2.0a-1, "Saving: one rule, two cases"):

- **Save** — writes the open DOCUMENT back to its own path, in silence. Enabled
  when the workspace is a document with unsaved edits.
- **Save as… / Save into project** — always enabled. Creates a NEW document:
  a project GLB with a `documents[]` row and a `doc_<…>` id, then clears the
  autosave snapshot of the workspace it came from. It has minted no `scn_` id
  and written no `rv-scenes/<id>` row since plan-716 phase 6.

The **UNSAVED** chip means *"the working scene has edits beyond its baseline"*.
It does **not** mean "you'll lose this on reload" — the autosave snapshot is
written every 2 s and restored on next boot. The chip exists to nudge the user
toward saving into the project before the autosave snapshot gets overwritten by
switching workspaces.

### 3.1 localStorage layout

All Scene-related keys live in [`src/core/hmi/scene/rv-scene-storage.ts`](src/core/hmi/scene/rv-scene-storage.ts).
Five keyspaces, one job each:

| Key / Prefix | Shape | Purpose |
|---|---|---|
| `rv-scenes-index` | `RvSceneMeta[]` (sorted by `modifiedAt` desc) | **Legacy since plan-716** — nothing writes user content here. Read by the migration, and by the folder-project scene cache (§2.0-00) |
| `rv-scenes/<id>` | `RvScene` (schemaVersion 3) | A row — base + empty ops; the bytes are the GLB it points at. **Legacy since plan-716**: written only by the folder-project scene cache, read by the migration. A row still carrying schemaVersion 2 raises the F10 error (§2.0-0) |
| `rv-scenes/active` | `{ id }` | Pointer to the most recently active saved scene — used as a boot-time defense-in-depth fallback when `?scene=` is missing |
| `rv-scenes/draft/<baseKey>` | — | **DEAD.** Was the per-base autosave snapshot. No writer since plan-397 phase 7, no reader since plan-413 phase 6; only `clearDraft` / `clearDraftsForScope` / `clearAllScenes` still touch it, to remove what an earlier release left |
| `rv-scenes/scene-draft/<savedId>` | — | **DEAD**, same story, keyed by saved id; `clearSceneDraft` is what is left of it |

Where:
- `baseKeyOf({ kind: 'empty' })` → `'empty'`
- `baseKeyOf({ kind: 'builtin', url })` → `'builtin:' + encodeURIComponent(url)`

`baseKeyOf` is **not** dead with these keys: it still names the live GLB body
slot `draft/<baseKey>` (`scene-store.ts:793-798`), so the exact spelling of the
built-in URL decides which autosave a reload resumes. Measured (plan-421 phase
3, boot paths in `main.ts:1281/1397-1409/1438-1445`) for one and the same model:

| Boot path | `baseKeyOf` |
|---|---|
| default boot / saved model / `defaultModel` | `builtin:%2Fmodels%2FDemoRealvirtualWeb.glb` |
| `?scene=builtin:DemoRealvirtualWeb.glb` | `builtin:%2Fmodels%2FDemoRealvirtualWeb.glb` (same) |
| `?scene=builtin:…&option=bosch` | `builtin:%2Fmodels%2FDemoRealvirtualWeb.glb%3Foption%3Dbosch` |
| `?model=/models/DemoRealvirtualWeb.glb` | `builtin:%2Fmodels%2FDemoRealvirtualWeb.glb` (same) |
| `?model=DemoRealvirtualWeb.glb` (bare filename) | `builtin:DemoRealvirtualWeb.glb` |

So the two entry paths people actually compare — default boot and
`?scene=builtin:` — agree. The splits come from `?option=` (by design: a variant
is a different scene body) and from `?model=` being taken **raw** at
`main.ts:1397`, without the catalogue resolution every other path performs. The
latter is a genuine identity split and is recorded, not fixed, here.

**The per-base draft key is still project-scoped**, and now for one reason
only: so the leftovers of one project can be removed without touching another's.
`setDraftScope(projectId)` (module state in `rv-scene-storage.ts`, set when a
project opens) makes the key `rv-scenes/draft/<projectId>:<baseKey>` instead of
the bare `rv-scenes/draft/<baseKey>`, which is what `clearDraftsForScope()`
matches on. "No project" keeps the historic unscoped key — and the close path
deliberately does **not** sweep it, because a slot with no project prefix
belongs to nobody's project.

#### 3.1a The scene body as GLB (plan-397, phases 5–7)

The five keyspaces above are the **op-log** world. Plan-397 made a scene a GLB
file in three steps — contract (5), write path (6), migration (7) — and none of
the five was renamed, rewritten or deleted. A sixth keyspace sits beside them:

| Key / Prefix | Shape | Purpose |
|---|---|---|
| `rv-scene-glb/<id>` | `{ sha, size, updatedAt }` | **Pointer** to the scene's GLB body. The bytes themselves live in OPFS under `sha`; `sha` is also the scene's content revision |

Three consequences worth knowing before touching this area:

- **`ProjectBackend.readScene()` no longer returns an `RvScene`.** It returns a
  `SceneRecord` — `{ glb, meta, revision }`. The `legacy` field that once
  carried a pre-397 JSON body is gone with plan-413 phase 6; a `.scene.json`
  path now raises the F10 error before any I/O happens.
- **`writeScene()` only accepts GLB, and only under a precondition.**
  `expectedRevision` is a compare-and-swap against what is stored now: a
  revision (replace exactly that), `null` (must be new), or omitted
  (unconditional — the migrator's escape hatch). A mismatch throws
  `SceneRevisionConflictError` instead of overwriting, which is also how an
  edit made in the project folder by something other than the viewer surfaces.
- **Writes are all-or-nothing.** The folder backend restores the previous bytes
  (or removes the file it had to create) when a write fails; the browser
  backend puts the body in OPFS first and moves the pointer last, so there is
  no instant at which the pointer names a half-written body.

#### 3.1b Three body slots (phase 6)

The write path moved in phase 6. A body lives in one of three slots, mirroring
the three localStorage draft keyspaces they replace:

| Slot | Contents |
|---|---|
| `<sceneId>` | the **committed** body — what `save()` writes |
| `draft/<sceneId>` | unsaved changes to a saved scene |
| `draft/<baseKey>` | unsaved changes to a workspace that was never saved |

Folding the draft into the committed body would be the obvious simplification
and is the wrong one: it would overwrite the saved scene on every keystroke and
make "discard changes" a lie.

`save()` writes **unconditionally**; the compare-and-swap belongs on the
autosave. A CAS on an explicit save would refuse the user against their *own*
autosave, which is almost always the last thing written to that slot.

#### 3.1c The op-log migration, and why it is no longer here (phase 7 → plan-413 phase 6)

Plan-397 phase 7 shipped a boot-time migrator that converted every **explicitly
saved** scene once, additively: the record at `rv-scenes/<id>` came out
byte-for-byte unchanged and only a body plus a marker key were written. It ran
for one release. Plan-413 phase 6 removed it together with the reader it
depended on, so the module, the marker and the boot call site are all gone.

Two decisions from that release are worth keeping on record, because they
explain what a holdout's storage looks like today:

- **autosave-only drafts were never migrated.** Not a filter but a property of
  the enumeration: `listMetas()` is the catalogue of explicitly saved scenes,
  and the draft keyspaces had their own enumerators the migrator never called.
  Anything that only ever existed as an autosave was lost at that point, by
  design and with the user's agreement.
- **localStorage was readable for exactly one release.** That release is over.
  A record that missed the window raises the F10 error (§2.0-0) rather than
  being skipped, so the situation is visible instead of silently shrinking the
  scene list. Tests that need to *construct* a dead slot do so through
  `tests/helpers/dead-draft-slots.ts`, which seeds an opaque marker into a key
  — never a scene, because nothing parses one there any more.

### 3.2 Two autosave snapshots — why?

The split exists because a working scene can be in one of two qualitatively
different states:

| Working-scene state | Saved? | Autosave snapshot (GLB slot, §3.1b) | Resumed by |
|---|---|---|---|
| Fresh built-in or "Untitled" empty | `_saved == null` | `draft/<baseKey>` | `openBuiltin(url)` / `openEmpty()` |
| Edits on top of a saved scene | `_saved != null` | `draft/<savedId>` | `openScene(savedId)` |

(The identically-named *localStorage* slots are dead — see §3.1. The split
below is about the GLB body slots that replaced them.)

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

The autosave is written by `_afterOpsChanged()` on a debounced timer
(`DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000` ms). Since plan-397 phase 6 it writes a
**GLB body**, not an op log; the branch structure is otherwise unchanged — two
effective branches, not three:

```
if (canUndo || canRedo || _saved == null):     // working scene has content
    → _autosaveBody()          // bake the op log into the draft body slot
else:                                          // pristine: edits match baseline
    → dropSceneGlbBody('draft/<savedId>')
    // NB: no clearDraft(base) here — the per-base slot is *not* cleared
    //     in the pristine path. It is only cleared on first save() / saveAs().
```

The autosave timer is cancelled at the top of every `_loadIntoWorkspace()`
call so an in-flight save can't write the previous workspace's state into
the new workspace's slot.

#### 3.3a The base bytes, and the 35 MB question

A debounced write cannot re-fetch a 35 MB base every two seconds, and
`saveSettingsIntoModel` documents why holding one is dangerous: a source buffer
per model was the double-buffering that produced blank scenes on mobile.

The answer is narrower than either: `SceneStore` holds the base bytes of the
**open scene only**, keyed by what they were read from, fetched lazily (a
session that never edits never pays for it) and released by `dispose()`. The key
is what prevents the real hazard — a workspace switch baking the new scene's
edits onto the old scene's bytes.

`dispose()` also cancels the pending autosave. Before phase 6 a discarded store
was harmless (it wrote an op log nobody read again); now that timer writes a
GLB body into a shared slot, so a store outliving its usefulness by two seconds
could overwrite whatever replaced it.

#### 3.3b A failed autosave is visible (plan-422)

`_autosaveBody()` has two failure paths and, until plan-422, only one of them
said anything. A failed compare-and-swap became a `conflict` notice; every
other failure became a `console.error` and nothing else — so the interface
looked identical whether the draft body had been written or refused. Since a
refused bake writes NO body at all, the whole session's unsaved work depended
on a line nobody reads.

Both paths now surface through the scene-sync notice channel
(`rv-scene-live-sync.ts` → `StorageNoticeBanner`):

| Failure | Notice | Cleared by |
|---|---|---|
| CAS refused (another writer) | `conflict`, critical | user action |
| Anything else (bake refusal, backend error) | `autosave-error` (slot + reason), critical | the next SUCCESSFUL autosave of that slot |

The channel carries a **stable notice id** (`kind + slot`) so a notice can be
withdrawn individually: `clearSceneSyncNotice(id)` removes one entry AND emits
a clear event, which the banner needs because it keeps its own copy of what it
is showing. Banner precedence is `conflict` > `autosave-error` >
`orphaned-bindings` > storage-persistence warning > `other-tab`.

`orphaned-bindings` (warning, one per model load) is the same channel reporting
saved `SignalLinks` mappings whose carrier `nodePath` is not in the loaded model
— see `orphaned-bindings.ts`. The ops are kept, never auto-deleted: re-opening
the previous model makes them live again.

Since plan-425 the notice also carries `repairable`: saved links whose SLOT was
located unambiguously by the second pass above. When it is non-zero the banner
grows a **Reconnect** button that applies every unambiguous repair
(`repairAllOrphanedBindings`). Ambiguous and typeless orphans get no button and
no guess — they are listed in the bindings overview panel with the reason.

#### 3.3c A shared document has ONE draft truth (plan-711 §2.4)

A document that scene and editor share (§2.1c) is persisted in **two forms on
purpose**, and they are not two truths:

| Form | Written by | What it is |
|---|---|---|
| **op record**, frame keyspace | `RvDraftAutosave`, through whichever facade holds the document | the document |
| **baked GLB body**, scene slot `draft/<sceneId>` | `SceneStore._autosaveBody` | a rendering of a PREFIX of that log |

The slot is derived from the document's **identity**, not from either side's
instance id: `sharedDocumentFrame(base)` → `{projectId: null, rootDocumentId:
'scene:<sceneId>', occurrence: ''}`. That is what makes both sides address one
record, and what lets a side that never saw the editor's instance id recover it.

Every such record carries a **stamp** (`bytesCache = {slot, revision, floor}`)
saying which prefix of the log the bytes already hold. `floor` is read BEFORE
the bake, for the same reason `save()` reads its own floor before `_commitBody`:
an op that arrives mid-bake is not in the bytes.

**The rule** ([`rv-document-recovery.ts`](src/core/ops/rv-document-recovery.ts),
asked by `SceneStore._planDocumentRecovery` on every scene open):

| Left behind | Verdict |
|---|---|
| nothing | `none` |
| bytes only, or a record with an empty log | `bytes` |
| record + bytes, stamp matches slot AND revision | `ops`, cache `valid` — the bytes are the base, `ops.slice(floor)` replays on top (filtered to the scene projection; what it drops is counted) |
| record + bytes, **no stamp** (an old slot beside a new record — the transition moment) | `ops`, cache `unstamped` — the bytes stand as they are, the tail is reported as not reinstated |
| record + bytes, stamp names another slot or another revision | `ops`, cache `moved` — same treatment |
| record, no bytes | `ops`, cache `absent` |

So the answer is deterministic and never a timestamp race: **the record decides;
the cache is used only when it can prove which prefix it holds.** A recovery
that cannot reinstate everything says so (`describeDocumentRecovery` → console)
rather than replaying a log of unknown overlap and doubling half of it.

Lifecycle of the record: written while a binding is live (and flushed on a
forced editor exit), dropped by `SceneStore` the moment the document is clean
again — the writer is gone by then, so the store is the only side that can. The
editor's own recovery never offers it: `assetDraftOfFrame` refuses a
`sceneDocument` base, and `chooseRecoveryRoot` skips such records so a scene
record cannot be elected root and take a genuine editor draft down with it.

The **unequal** case is untouched: two documents, two writers, the pre-711
save/restore path.

### 3.4 Save / Save as… / Discard / Delete semantics

Every row below is on DOCUMENTS since plan-716 phase 6: a project GLB plus a
`documents[]` row, addressed by a `doc_<…>` id. No operation mints a `scn_` id
or writes an `rv-scenes/<id>` row any more — the guard test
`tests/scene-removal-guard.test.ts` is what keeps that true.

| Operation | What happens | Snapshot slots |
|---|---|---|
| **Save** (`save()`) | Writes the open document back to its own path and manifest row, in silence (§2.0a-1 case 1). A read-only SOURCE has no path to write to and takes case 2 instead. | Both per-base and per-document snapshots cleared |
| **Save as… / Save into project** (`saveAs(name)`) | Creates a NEW document through the one create seam: a project GLB with a fresh `doc_<…>` id and manifest row; `parentId` records what it came from. | Same as above |
| **Discard** (`discard()`) | Re-opens the last saved state, **first clearing the per-document snapshot** so we don't restore the very edits we're discarding | Per-document snapshot cleared, then read |
| `delete(id)` | Removes the GLB + its manifest row. Also `clearSceneDraft(id)` to prevent stale snapshots surviving id collisions | Per-document snapshot cleared |
| `rename(id, name)` | Manifest row + body updated atomically (body first, then row) | Untouched |
| `duplicate(id)` | Writes a fresh document (new id, new file); bumps `parentId` | Untouched |

The **Save** button lives in `DocumentCard` — the one card that shows what is
open, in the hierarchy header and as the Projects-dashboard hero (plan-709
§2.1). It is never disabled: A11y-wise a disabled control breaks the keyboard
and screen-reader path, and `saveDocument()` is idempotent, so a click on a
clean document reports "Saved" instead of doing nothing silently. What DOES
change before the click is the verb — a source that cannot be written to reads
**"Save into project"**, and a stale frame shows the conflict instead of a save.

### 3.5 URL routing

`SceneStore` always reflects the active workspace into the URL via
`history.replaceState`:

**Which param gets MINTED, and which only gets READ**, is the one thing to hold
on to here (plan-716 §2.4, plan-720 F4): a DOCUMENT is written as `?doc=<id>`.
`?scene=` is still minted, but only for the bases that have no document id to
put in `?doc=` — `builtin:`, `published:`, `empty` — and `updateUrlSceneParam()`
in `scene-store.ts` is the only writer of it. On the READ side nothing narrowed
and nothing ever will: `?scene=<doc id>` and `?scene=<scn_ id>` both keep
resolving through the permanent alias map (`rv-doc-alias.ts`), so every link and
bookmark ever handed out stays good.

| URL form | Effect on boot | Written by |
|---|---|---|
| `?doc=<doc_…>` | `openDocument(id)` — the form minted for every document (plan-716 §2.5) | `save()`, `saveAs()`, `updateUrlDocumentParam()`, `web_link_compose` |
| `?scene=<id>` | Read-only alias route: resolves a document id or a pre-migration `scn_…` id through `rv-doc-alias` and redirects to `?doc=` | nothing mints this any more — kept resolving forever |
| `?scene=builtin:<filename>` | `openBuiltin(url)` for the matching entry | `openBuiltin()` |
| `?scene=empty` | `openEmpty()` (resume per-base empty draft if present) | `newEmpty()` and `openEmpty()` |
| `?scene=published:<name>` | Legacy alias route (plan-731): resolves `<name>` against the manifest's `documents[]` — the document whose path basename matches — redirects to `?doc=` and opens it. The row's `mode` is applied unless `?mode=` overrides. A name the manifest does not carry falls through to the default boot chain | nothing mints this any more — kept resolving forever |
| `?glb=s:<id>` / `?glb=<url>` | A **shared** GLB from a host we do not control (plan-386). Loaded via `RVViewer.loadModel()` **directly** — deliberately below `main.ts`'s `loadModel()` hull and below `openBuiltin()`, because both persist. Writes nothing at all, and the URL is never rewritten. | nothing — read-only route |
| `?model=<url>` | Legacy alias — deprecated, falls through to default-model boot |  |
| (no identity param) | Falls back to: saved active id (`rv-scenes/active`) → the project manifest's `activeSceneId` (resume priority 4, "decision 24") → `?model=` → `LS_KEY_MODEL` → `defaultModel` from settings.json → first available | — |

The URL is the bookmarkable identity; localStorage is the resume mechanism.
`rv-scenes/active` is defense-in-depth for cases where the URL was lost
(bookmark predating the URL-write fix, code path that forgot to call
`updateUrlDocumentParam`, etc.). `activeSceneId` in `project.json` is the same
job for a machine that has no local memory of the project at all — a fresh
device opening a delivered project. Its name is pre-716 and its value is a
document id; it is live, not residue.

### 3.5a Transient workspaces — foreign content that persists nothing

Two situations call for a workspace that is fully editable and writes nothing:
a published **Example** shipped with the deploy, and a **shared GLB** somebody
sent a link to (plan-386 §2.5). Both go through `SceneStore.openTransient()`.

`transient` is a field on the **workspace shell**, not on the store. Every path
that replaces the shell replaces the flag with it, and `freshShell()` /
`workspaceShellOf()` both default it to `false` — a whitelist. The alternative
(a store field each open must remember to clear) is the shape where one
forgotten reset leaves the user editing for an hour with autosave silently off.

What it suppresses:

| | Transient | Normal |
|---|---|---|
| `setActiveSceneId()` | never called | called with the saved id (or `null`) |
| Debounced autosave (`_afterOpsChanged`) | **not even scheduled** | schedules `_autosaveBody()` |
| GLB body write (`_writeBody` → `writeSceneGlbBody`) | refused (safety net) | writes the draft slot |
| `dropSceneGlbBody` housekeeping | skipped | runs on a pristine saved workspace |
| Body-slot **read** (`_resolveLoad`) | only the scene's own `scene-glb` id | `draft/<key>`, then the saved id |
| `updateUrlSceneParam` | not called by `openTransient` | called by every regular open |
| Op log, undo, redo, dirty | **unchanged — all in memory** | unchanged |

The gate sits at the top of `_afterOpsChanged()`, before the timer rather than
inside its callback: that way a workspace switch cannot let a pending write land
on the *next* scene's slot. It is one `return`, and it therefore covers the
plan-397 GLB-body path as well as the older op-log draft keys — gating only
`writeDraft` would have looked correct while the real writer ran underneath.

Transitions out of transient are all "replace the shell", so they need no code
of their own: `save()` / `saveAs()` (converting on purpose, and clearing the
flag *before* committing so the safety net does not refuse the user's own
write), `markGlbActive()`, `discard()`, and every regular `open*`. A
**failed** transient load restores the previous workspace wholesale — the load
installs the new shell before awaiting, so without that a broken foreign GLB
would leave the visitor looking at its wreckage instead of his own scene.

> **A comment is not a mechanism.** `openPublished()`'s docstring claimed "no
> side effects on the visitor's stored scenes" long before that was true: the
> load ran `setActiveSceneId(null)` and deleted the visitor's active pointer,
> and the autosave wrote a draft on his first edit. Fixing the seam fixed the
> Examples too.

**Persisting nothing is a promise to the visitor, not a dead end for him.**
Suppressing the writes was only half the seam; for a long time the other half
was missing, and the result was silent data loss in exactly the situation the
product is built for — someone opens a shared demo, binds their PLC signals,
presses F5, and everything is gone without a word having been said. The
workspace is now *visibly* transient and has a way out, through the one
vocabulary described in §3.5c. Nothing about the suppression table above
changed: the way out is a save, which converts the shell.

### 3.5b Shared-asset bookmarks (`rv-shared-bookmarks`)

The one key the receiver of a shared link may write — and only after clicking
*Add to my library* (plan-386 F13). Its own store, its own key, projected into
the library UI as **one** catalogue tab via
`addCatalogDirect('bookmarks://shared', …)`.

Why not the library store directly: `addCatalog(url, 'user')` fetches the URL
and parses it as JSON, which for a `.glb` is a guaranteed parse error;
`addCatalogDirect()` alone marks the key as bundled and never persists it, so
the bookmark would vanish on reload.

Each entry keeps `{ url, name, meta, expiresAt?, addedAt, expired? }`. A link
that comes back `410` is **marked, not removed** — and marked in the projected
*name*, because the library grid that renders it knows nothing about sharing, so
a flag would be an invisible marking. A full quota fails softly: the click still
shows the entry for this session and the caller learns it did not stick.

### 3.5c Unsaved, and the sharper question: unpersisted

The product says "there is unsaved work here" in one mark and asks about it in
one place.

**The mark.** [`DirtyDot`](src/core/hmi/rv-dirty-dot.tsx) — `warning.main`, 7px
inline and 6px as an icon badge, `data-testid="dirty-dot"`. It is the mark on
the asset card, on each dirty crumb of the document-stack breadcrumb, and in the
corner of the Projects icon in the ActivityBar. Before it there were five
spellings of the same statement (two hardcoded `#ff9800`, a `#ffb74d`, a
`warning.main`, and a `' •'` glued onto a label); a mark the user has to relearn
per panel is not doing its job. On the Projects icon the unsaved mark **replaces**
the ambient blue "writable project is open" dot rather than joining it — two
dots of different meaning in one 6px corner is noise.

**The two questions.** They are genuinely different and must not collapse:

| | Question | Who asks |
|---|---|---|
| `hasUnsavedWork()` | Does this differ from the named save? | the project switch/close guard, the dirty mark |
| `hasUnpersistedWork()` | Would a **reload destroy** it? | the page-level unload guard |

A normal workspace is `dirty` for most of its working life and loses nothing to
an F5, because the body autosave already wrote it. Warning there is how a guard
stops working: the user learns to dismiss it. Only two states genuinely lose
work — a **transient** workspace (never autosaved, by design) and a scheduled
write still sitting on the **debounce timer**. `SceneStore.hasUnpersistedWork()`
is exactly those two terms; `ProjectStore.hasUnpersistedWork()` adds the queued
folder write, the dirty open documents reported by the probe, and — since
plan-710 — any open document whose own draft write is still armed.

**It is a capability of the document layer now, not of the scene alone
(plan-710 F7).** The timer question used to be answerable only scene-side, so an
asset document mid-write was unguarded in *every* mode, editor included. It is
now an optional constructor callback,
`RvDocumentOptions.hasUnpersistedWork` — the same idiom as `onChanged` and
`canApply`, and a callback rather than an intrinsic for the reason `RvDocument`
gives itself: it announces change and owns no storage, so it cannot know what is
outstanding. Each lineage fills it with its own timer (the scene with its GLB
bake debounce, the asset lineage with `RvDraftAutosave.hasPendingWrite`), and
the editor plugin publishes the stack's answer through
`ProjectStore.setUnpersistedWorkProbe()`.

That probe is deliberately **separate** from the dirty-documents probe. The two
questions in the table above have two consumers, and folding "mid-write" into
`ProjectDirtyDocument` would have changed the project switch/close dialog as a
side effect of fixing the unload guard. `hasUnsavedWork()` is unchanged, and
`document-guards.test.ts` pins that it stayed so.

**One guard, one aggregation.** `ProjectStore` is the single place the terms are
added up, and `main.ts` installs the only `beforeunload` in the codebase against
it. The asset editor's own guard is gone: it was installed in `_activate`, so it
asked in editor mode and nowhere else, and it saw `this.doc` rather than the
whole stack. Two consequences worth knowing:

- `attachToSceneStore()` now runs right after the store is built, not inside the
  project-restore branch. Two of the three boot paths never reach that branch,
  and an unattached store makes the aggregation blind to the scene on exactly
  those paths. Attaching is two assignments plus the hydrator, which reads the
  cache or returns false with no project open.
- `hasUnpersistedWork()` on the scene seam is **optional** (`SceneStoreLike`), and
  a probe that throws fails *open*. A guard that throws on every unload would
  make the tab impossible to close.

**The way out.** The Projects dashboard carries a free-standing **Save as…**
button whenever the workspace is dirty, reading *Save to my scenes…* while it is
transient. `saveAs()` clears the transient flag before committing, so the scene
becomes an ordinary saved one and the whole table in §3.5a stops applying to it.
Until this button existed, `saveAs` could be reached only from inside the
switch-confirmation dialog — the offer appeared only once the user was already
leaving, and a transient workspace could not be saved at all without first trying
to navigate away from it.

Pinned by `rv-scene-transient.test.ts` (the scene half, including
"dirty-but-written is not at risk") and `project-exit-guard-documents.test.ts`
(the aggregation).

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
| **bundled** | Read-only, shipped with the build (`library/catalog.json` etc.) | The DemoRealvirtual project — authored in `public/project.json`, see below. `writeDocument` is refused with a reason. |

The `rv-project/*` localStorage keyspace:

| Key | Purpose | Owner |
|---|---|---|
| `rv-project/last` | Id of the last opened project — restored on boot | `project-store.ts` |
| `rv-project/resume/<projectId>` | The `(asset, mode)` pair last open in this project — boot's second line of defence behind `?doc=` (plan-702/703) | `rv-project-resume-store.ts` |
| `rv-project/recent` | Recent-project list for the picker | `rv-project-recent.ts` |
| `rv-project/workspace` | The workspace root that contains project folders | `rv-project-workspace.ts` |
| `rv-project/migration` | One-shot migration state (legacy loose keys → project) | `rv-project-migration.ts` |
| `rv-project/workfolder-offer` | "Adopt your old working folder as a project?" was offered | `rv-project-migration.ts` |
| `rv-project/browser/<id>` | Metadata for a browser-backend project | `browser-backend.ts` |

Two couplings back into this document: the project id scopes the per-base draft
key (§3.1), and `saveSettingsIntoModel()` writes through
`ProjectBackend.writeDocument` (§6.1), which is why "bundled" refuses that write.

#### 3.6a `project.json` — the manifest, schema 2

`RV_PROJECT_SCHEMA_VERSION` is **2** since plan-413 phase 2. What the manifest
holds:

| Field | Meaning |
|---|---|
| `documents[]` | **The list.** One `RvDocumentEntry` per document: mandatory `id`, `path`, `name`, `classification?` (cache), `revision?`, `sha256?`, `sizeBytes?`, `mtimeMs?`, `forkedFrom?`, `copiedFrom?`, `collections?` (plan-717: the user's filing, successor of the `library.json` sidecar), `missingSince?` (plan-717: the adopt verb's quarantine mark, absent on every healthy row). Unknown fields survive every read-modify-write. |
| `rv-project/documents-migration` | Marker recording that this manifest has been given a `documents[]`. Lives **in the file**, not in localStorage, because the thing being migrated travels (git, zip, a customer delivery, a second machine). |

`scenes[]`, `models[]`, `library[]` and `documentsBaseline` are **not written
any more** (phase 6). A stored manifest that still has them is converted on the
way in — read once, lifted into `documents[]`, then dropped — so the file this
build saves carries one list and no stale second copy of it.

**Ids are derived from the path, never minted at random** (`stableDocumentId()`).
The migration runs inside `readManifest()` — §13.3's rule — so it executes on
every read; a random id would give the same unchanged manifest a different
identity on every call, and a list whose identities move under it is a list
nothing can select in. It also means two machines opening the same git repo
agree without having to save first.

**The mirror is gone, and what replaced it is not a smaller mirror.** Step A of
the plan wrote the three arrays back on every save, with `documentsBaseline` as
the base of a three-way merge so an older client's edit to `scenes[]` could be
folded in rather than silently reverted. That was scaffolding with a stated end:
it came down once the delivery pipeline read `documents[]` (§3.11). What the
~80 places that used to read `project.scenes` read now is
`sceneDocumentsOf()` / `assetDocumentsOf()` — **projections**, computed at the
read site over the one list. A projection cannot go stale, cannot disagree with
its source, and cannot be edited behind its back, which is why the baseline and
the merge went with the mirror instead of following it into a new home.

The cost is stated rather than hidden: a client older than this build opens such
a project and sees no scenes, and if it saves, this build refuses the result
(§2.0-0). The forward direction still works — `migrateProjectDocuments()` builds
`documents[]` out of whatever arrays a stored manifest has — but the way back is
`project.json.bak` and git, not a code path.

Two backends read manifests **nobody converted**: the bundled one reads a
deploy's `project.json` over `fetch`, and the browser one reads a manifest an
older build of this app stored. Both apply `withDerivedDocuments()` on the way
in — the same read-side fallback the delivery pipeline keeps for an unmigrated
customer. It derives, it does not migrate: no marker, nothing written.

**Manifest writes are compare-and-swap.** `writeManifest()` takes an optional
`expectedRevision` and `updateManifestCas()` reads → applies → writes under that
precondition → retries against the fresh state. The `.bak` file that predates
this is crash insurance, not conflict handling.

**The listing is not the manifest.** `ProjectBackend.listDocuments()` is the
*display* list and is folder-driven for `models/` and `library/` — dropping
`Machine.glb` into `models/` **is** the act of adding it. `statDocuments()` is
the `(size, mtime, sha)` pre-filter behind the classification scan;
bundled/HTTP returns none, which is how it says "my manifest is authoritative —
do not scan me".

**The scan reads; the adopt verb writes** (plan-717 §2.2). This paragraph used
to end "…so a folder scan never rewrites a customer's `project.json` with fifty
entries nobody ordered", and the sentence is now split in two rather than
deleted:

- The **scan** still writes nothing. `listDocuments()` / `statDocuments()`
  allocate no identity and touch no file; a read-only project (bundled, HTTP, a
  folder whose readwrite grant was declined) therefore never gains a row at all
  and keeps showing scan-derived display rows, exactly as before.
- The **adopt verb** — `adoptDiscoveredDocuments()` in
  [`rv-asset-identity.ts`](src/core/project/rv-asset-identity.ts), run by
  `ProjectStore` after an open and after every `rescanDocuments()` — is what
  gives those files authored rows. It is explicit (its own method, not a side
  effect of looking), **writable-only**, single-flight, logs one line per
  adoption/move/quarantine/removal, and commits **once** per run through
  `ProjectStore.applyManifestDelta()` — a real delta merge against the freshly
  read manifest, so two tabs adopting at the same time converge instead of
  overwriting each other. An empty delta means no write at all, which is why
  every run after the first leaves a customer's `project.json` byte-identical.

So the customer's file is written *once*, when their existing library is first
adopted, and that one diff is intended: it is what makes rename, move and
collections survive for those files. What never happens is a rewrite nobody can
see or explain.

Two row fields belong to that verb. `sha256` is maintained by it (a folder
`statDocuments()` cannot supply one) and is the **move signal**: a row whose
file vanished is matched against a new file with the same digest — only when
the old position is empty, which is what keeps an external *copy* from merging
two documents into one identity. `missingSince` is the **quarantine mark**: a
row whose file is gone is marked, not deleted, and is dropped only by a later
run once the mark is older than 15 minutes. A file that comes back clears the
mark and keeps its id and its collections.

### 3.6b One document registration (plan-717)

Before plan-717 there were two ways a document could come to exist, and which
one applied depended on the folder it was in. A **scene** was declared: created
through the app, given a manifest row and a minted id that never changed. A
**library or models file** was discovered: the file simply existed, and its row
— id included — was re-derived from its path on every scan. That second model is
why a rename used to break references. Rename was copy + delete, the path
changed, so the derived id changed, and every `assetId` written into a saved
scene pointing at the old one resolved to `null` — silently, because a miss in
the reference resolver is not an error.

Since plan-717 there is one model: **every document a writable project owns has
an authored manifest row with a stable id.** The mechanics are §3.6a above (the
scan reads, the adopt verb writes). What follows is what that means in practice.

**One create, one rename, one move.** `createDocument` writes bytes *and* row in
one verb; rename and move both go through `applyTreeMove`, which computes the
manifest first and refuses before moving a byte. A rename changes the row's name
**and** the file name and keeps the id; a move changes only the path. The
blob-only verbs that used to sit beside these (`createEmptyAsset`,
`renameAsset`, `duplicateAsset`, `deleteAsset`) are deleted, and
`registration-removal-guard.test.ts` keeps them deleted. `applyTreeMove` no
longer mints a row for an unregistered file either: adoption guarantees the row,
so a gap is a bug and it says so instead of hiding it.

**Collections live on the row.** `RvDocumentEntry.collections` is the user's
filing. The catalog shows row collections **plus** folder-derived chips (the
folder is a place, the collection is a choice), and the Layout Planner filter
reads the same value the Collections editor writes — a loop that was open from
plan-413 until now, because the old sidecar was written and never read back.

#### The sidecar is over

`library/library.json` is no longer written by anything. On the first adopt run
of a project that has one, it is parsed, merged into the rows (row wins, the
sidecar fills only gaps), and **deleted after the commit succeeds** — never
before, so a crash in between costs nothing and the next run retries. A
`library.json` this build cannot parse is reported and left completely alone.

Four consequences worth knowing before they surprise someone:

- **The first run after upgrading writes a diff into a customer's project
  folder** — new `documents[]` rows, a `rv-project/sidecar-migration` marker,
  and the sidecar file removed. This is intended: it is what buys rename, move
  and collections for files that never had a row. It happens **once**; the
  adopt verb's empty-delta guard means every later run leaves `project.json`
  byte-identical. Mention it before a delivery, so a version-controlled customer
  folder does not look like it changed on its own.
- **A file copied into a library by the operating system arrives without its
  collections.** They are in the source project's manifest, not beside the
  bytes, and a Finder copy does not carry a manifest. The file is adopted as a
  new document with a new id and no filing. This is a deliberate trade, the same
  one a photo catalog makes: the alternative is writing a second metadata home
  next to every file, which is exactly the two-truths problem that produced the
  stale-collections bug. Use *Copy to…* inside the app when the filing matters —
  that path carries the row.
- **There is no rollback path for collections.** Downgrading to a pre-717 build
  after a project has been ingested means the older build looks for a
  `library.json` that no longer exists, so it shows no collections and offers
  the folder fallback instead. Nothing is lost — the values are in the rows, and
  coming back forward shows them again — but the older build cannot see them and
  cannot be made to. If it then writes a *new* `library.json`, the marker in the
  manifest means the returning build ignores it rather than letting stale values
  overwrite live rows.
- **A read-only project whose sidecar was never ingested shows no collections.**
  The one-generation read fallback (`legacyCollectionsFor`) answers from the
  parsed sidecar only where the row is silent — but a read-only project (bundled,
  HTTP, a folder whose readwrite grant was declined) can never be adopted, so its
  `library.json` is never read into anything. Such a project displays folder
  chips and nothing else. This is a known, accepted gap: the population is
  deployed and bundled projects, which ship their manifest from the build and
  therefore have rows already; a *read-only folder with a hand-written sidecar*
  is the uncovered case. It disappears with the fallback itself.

The read fallback lasts **one release generation** and then goes. Its shape says
so: `LegacySidecarMeta` in
[`library-sidecar-ingest.ts`](src/core/library/library-sidecar-ingest.ts) is a
read-only type deliberately not assignable from the writable one, so nothing in
this build can produce a value of it.

#### Orphan rows are quarantined, not deleted

A row whose file has vanished is not removed on sight. The first adopt run that
notices marks it `missingSince: <iso>`; a later run removes it only if the file
is still gone **and** the mark is older than 15 minutes. A half-copied folder, a
cloud-sync lag or a file the user is in the middle of moving therefore keeps its
id and its collections, and a file that comes back clears the mark outright. The
window is a wall-clock one because the save cascade fires `rescanDocuments()`
seconds apart — a "second run" rule alone would expire nothing.

This is not the same thing as a delete. A user deleting a document is an
intention, and it goes to `.trash/` where it can be recovered. An orphan is a
file that is *already* gone from outside the app: there are no bytes left to
save, only a pointer, and the quarantine is about not throwing that pointer away
while the disappearance might still be temporary.

### 3.6c The full view — every file, verbs only where they mean something (plan-445)

The project browser used to show four curated listings: manifest documents, the
paths `docs-index.json` points at, `*.connect.json` and `*.knowledge.md`. That
was a deliberate choice — those four are exactly the rows a move has to keep
honest — and it was also why users could not find their own files. Since
plan-445 the browser lists **everything the project folder holds**, and the old
distinction survives as *what can be done to a row* rather than as *whether the
row exists*.

**One walk.** `ProjectBackend.listAllFiles()` (folder backend) traverses the
project folder once and applies the internals filter; `listProjectFiles(backend)`
splits the result into `configs` / `knowledge` / `plainFiles`. Both the dashboard
and the MCP tool `web_project_tree` call it, which is what keeps the two trees
identical — before this, `loadProjectTree()` built its own input and dropped the
config and knowledge lists entirely. A backend with no folder to walk (bundled,
HTTP) omits `listAllFiles`, and the helper falls back to the two per-ending
walks with no plain files.

**Internals** (`isInternalProjectPath`, one function, in
`backends/project-backend.ts`): any path segment starting with a dot,
`project.json`, `docs-index.json`, and the `thumbnails/` cache. The other
reserved folders (`settings`, `connect`, `rag`) stay visible — the tree already
collapses them under its *System* node, which is a better answer than hiding
files a user legitimately reads.

**Inert rows.** A file in none of the four reference listings arrives as
`plainFiles` and becomes a tree node with `inert: true` and a
`{ kind: 'plainFile' }` ref. It is visible and selectable and carries no verb at
all, because there is no manifest row and no docs-index row for a move to keep
honest. The rule is enforced in three independent places: the host builds an
empty verb set (so no context menu opens), `ProjectTree` excludes `inert` from
its `editable` derivation (so F2 and the native drag start are dead), and
`canMoveInTree` / `canRenameInTree` refuse an inert **source** with the reason
`inert` — which is what covers the MCP write path, where neither of the first
two exists.

**Display names.** A classifier ending is stripped for display
(`device.connect.json` → `device`). When that short form would collide with a
sibling in the same folder, the *stripped* row falls back to its full file name;
the row that owns its name outright keeps it. Paths, refs and writes are
untouched — this is presentation only.

**Moves use the file name, not the display name.** `canMoveInTree` derives its
destination from the last segment of `relPath` (`fileNameOf`). It used to use
`node.name`, which is the display name: moving `models/Bar.glb` (shown as `Bar`)
produced `Bar`, the extension was lost, the asset walk stopped matching the file
and the row disappeared from the browser altogether — reported as "items on the
top project level are invisible after a move" (LOP-119). The collision check now
runs on the destination **path** as well as on the display name.

### 3.7 Document classification (plan-413, phase 1)

Since plan-397 every model is a GLB. plan-413 adds the answer to *what a
document is* — and puts it **inside the GLB**, not in a manifest:

```
scenes[json.scene ?? 0].extras.realvirtual.Classification
  { v: 1, level?: 'part'|'assembly'|'plant'|'scene', tags?: string[] }
```

**Why in the file.** A share link is one URL, a copy between libraries is a byte
copy, an export is a download — there is no sidecar on the other end of any of
them. So the manifest's `classification` field is a **cache** of this block,
never the source. When they disagree, the GLB wins; the cache is replaced, never
merged. (`library.json` used to be a second such cache. Since plan-717 it is
neither written nor consulted for this — see §3.6b.)

**Where exactly.** The same normative location `SceneCamera`, `SceneSettings`,
`Connections` and `rv_share` already use — the default scene's extras, resolved
as `json.scene ?? 0` (`defaultSceneExtras` / `ensureDefaultSceneExtras` in
[`rv-glb-chunks.ts`](src/core/persistence/rv-glb-chunks.ts)). Deliberately not
`asset.extras`, which the glTF idiom would suggest: three.js hands scene extras
through as `scene.userData` and the whole existing load path consumes that, so a
second metadata location would recreate the fragmentation this plan removes.

| Concern | Code |
|---|---|
| Types, parsing, level mapping, tag normalisation | [`rv-document-classification.ts`](src/core/project/rv-document-classification.ts) |
| Write (JSON-chunk patch, BIN tail untouched) | `writeClassification()` in [`rv-scene-glb-bake.ts`](src/core/hmi/scene/rv-scene-glb-bake.ts) |
| Read from a loaded scene | `readClassificationFromScene()` in [`rv-scene-glb-read.ts`](src/core/hmi/scene/rv-scene-glb-read.ts) |
| Preserved on asset re-export | `exportAssetGlb(..., classification)` in [`rv-asset-glb-export.ts`](src/core/editor/rv-asset-glb-export.ts) |

**Three-state write semantics**, identical to `SceneCamera` and `SceneSettings`
and for the same reason: `undefined` means "no opinion" and leaves an authored
block alone (folding one field edit into a model must not un-classify it),
`null` clears it, a value replaces it. An *empty* classification — no level, no
tags — is treated as `null`, so "classified as nothing" and "never classified"
stay one state on disk.

**Everything is optional.** The entire Unity export corpus carries no
classification and keeps loading unchanged; a missing level renders as
"Unclassified", which is a display state and not an error. Malformed or hostile
blocks yield `null` or a partial record — never an exception.

**One level enum, shared with `rv_share`.** `RvShareLevel` *is* `DocumentLevel`
since plan-413. The v1 spellings are still read and mapped on the way in
(`component` → `part`, `model` → `plant`); nothing writes them again, and
`rv_share` blocks are emitted at `v: 2`. Existing `rv_share` data is **not**
moved — it keeps its own key at the same scene; only the vocabulary is shared.

### 3.8 Example scenes (plan-413, phase 3)

The Examples shelf was the last place in the product where a scene was not a
file. `public/scenes/*.scene.json` were op logs fetched, validated and replayed;
everything else had been a GLB since plan-397. They are GLBs now:

| Piece | Before | Now |
|---|---|---|
| `public/scenes/` | `<name>.scene.json` (op log) | `<name>.glb` (baked body) |
| `scenes/index.json` | `[{file:"X.scene.json",…}]` | `[{file:"X.glb",…,level?}]` — same shape plus the classification level. **Removed for our own deploys in plan-731**; still written for a customer project with its own `scenes/` folder, and still read by a `discover` backend on a foreign root |
| `SceneStore.openPublished` | took a parsed `RvScene`, validated it | takes the **URL**, opens a transient scene over a `builtin` base |
| `SceneStore.addPublishedToMyScenes` | cloned the record, new id | copies the **bytes** into a new DOCUMENT in the open project (plan-716); no `scn_` id, no catalogue row |
| `?scene=published:<name>` | direct `fetch` + `resp.json()` in `main.ts` | catalogue lookup, then the same GLB path (a `documents[]` alias since plan-731) |
| `BundledBackend.readScene` | JSON branch for examples | the GLB branch it already had for project scenes |

Three consequences worth knowing:

- **The catalogue is authoritative for the deep link.** No existence probe is
  made, because none is possible: a Vite dev server, and any host with an SPA
  history fallback, answers `200` with `index.html` for `scenes/Whatever.glb`.
  `index.json` and the files beside it come out of the same deploy step, so an
  example that exists is an example that is listed.
- **`openTransient()` refuses a non-empty op log.** Foreign content arrives as
  bytes; that is now an enforced invariant rather than a convention, so phase 6
  can delete the replay path without a caller quietly depending on it.
- **A pre-413 `index.json` entry is skipped with a `console.warn`**, not
  silently — an Examples list that shrinks to nothing should say why.
- **The catalogue carries `level`.** A bundled source is never scanned (§3.7),
  and reading each example's classification out of its GLB would mean
  downloading every example just to draw a list — so the level rides along in
  `index.json` and is cached onto the manifest row. `publishedSceneIndex()` in
  `scripts/_bunny-lib.mjs` writes it for a customer project's own Examples
  (§3.11).

The conversion itself is `tests/bake-published-scenes.node.test.ts`: it ran the
two op logs through the same `materialise()` + `bakeIntoGlb()` pair a user's
Save goes through (`RV_BAKE_PUBLISHED=1`), and without that variable it verifies
the committed GLBs instead. `scripts/_bunny-lib.mjs` prunes `Test*` examples from
a public `dist/` by both extensions, so the DES test scene still never reaches
the public CDN.

### 3.9 The CONNECT boot catalogue is NOT a project manifest

`main.ts` reads `manifest.models` from the CONNECT gateway's `/model/manifest`
endpoint. Plan-413 replaced `models[]`/`scenes[]`/`library[]` with one
`documents[]` list — *in the manifests realvirtual WEB writes*. This one it does
not write: CONNECT is a separate program with its own release cycle, and that
field name is its published contract. The boundary is therefore a **compatibility
adapter**: CONNECT's `models[]` is translated into viewer catalogue entries at
that one call site, and the document model begins on the other side of it. Same
decision plan-397 took for the plan-700/701 delivery manifests. If CONNECT ever
speaks `documents[]`, the change belongs at that call site and nowhere else.

### 3.10 Copy and move between sources (plan-413, phase 5)

A document could not leave its project. The library verbs from plan-372 —
rename, duplicate, delete — all operate on **one** backend, the active one, and
copy/move did not exist. Anyone who needed a part in a second project exported
and re-imported it by hand, losing the identity every `AssetReference` hangs
off.

**The transfer session** ([`rv-document-transfer.ts`](src/core/project/rv-document-transfer.ts))
is what made a two-sided operation possible at all. The backend contract
requires `writable && active` to write, and a move needs write rights on **both**
sides, so a "passive handle" cannot work. A session therefore opens up to two
backends for the length of one verb — the active side is delegated to, an
inactive side is activated and closed again in a `finally` — and gives each side
exactly four operations: read bytes, write bytes, delete bytes, edit one manifest
row.

- `withTransferSession(req, fn)` is the only shape that can promise "closed no
  matter what", and it **serialises**: two verbs fired in quick succession both
  run.
- `openTransferSession()` exists beside it as the primitive and **refuses** a
  second session rather than queueing — a caller that forgets to `close()` would
  otherwise hang with no symptom.
- This is not a loophole in the one-writer rule (§2.2.1b): a `FolderBackend`
  with no writer host creates no `RVProjectFolderWriter` on `activate()` and
  therefore never subscribes to the global scene-mutation bus. The session never
  asks for a writer.

**Identity rules.** Copy makes a **new** document: a fresh `id` plus
`copiedFrom`. Move keeps the **id** and retires the original into the source's
`.trash/`. That is what makes a placement still resolve after a move — the
project-library source answers to the document id as well as to its path-derived
catalogue id. Two sources can legitimately claim one id between "the copy
arrived" and "the original row is gone"; the resolver stays first-source-wins
and `findDocumentIdCollisions()` is what can say *why there are two*.

**The bytes decide what arrives.** The classification is never passed in — it is
read back **out of** the arrived copy, so a stale row in the source cannot
describe the file in the target. `sha256`, `mtimeMs` and `revision` are dropped
for the same reason: they describe the source's file, and carrying them over
would let the target's scan pre-filter clear on bytes it has never looked at.

**Order, and what each failure costs:** read → probe the name → write → read
back and check the size → classify from the copy → manifest row → sidecar. A
failure from the manifest row onwards deletes the partial copy. A move whose
trash step fails *after* the bytes arrived keeps the copy and says so — a
duplicate is tidy-up, a loss is not (§5.4 of the plan). Verification is by
**size**, not by hash: re-digesting a hundred megabytes on every transfer is the
price that would make the verb unusable, and the write surfaces are
all-or-nothing anyway.

**The target is always `library/`.** Putting a scene into a foreign project's
`scenes/` would need a scene manifest row, a body revision and an id the scene
index agrees with — a second, larger feature under the same verb name.

### 3.11 The delivery pipeline reads `documents[]` (plan-413, phase 6)

The Node scripts of plan-700/701 never open a project in a browser, so they see
whatever is on disk. They read the one list now, through one shared helper
([`scripts/_rv-manifest.mjs`](scripts/_rv-manifest.mjs)) rather than four copies
of the same three lines:

| Script | What changed |
|---|---|
| `validate-project.mjs` | Validates `documents[]`: array shape, mandatory `id` (F2), relative paths, existence at the entry's own path (plan-736: the second candidate the row's `section` used to name is gone), and a stated `sha256`. The three legacy arrays are still checked — an unmigrated customer repository is not an invalid project. |
| `_bunny-lib.mjs` | `publishedSceneIndex()` derives the curated `scenes/index.json` from the scene documents and **requires a `.glb`**; a `.scene.json` entry would publish a catalogue row pointing at a format the viewer no longer opens. It carries `classification.level` into the catalogue, because a bundled deploy is never scanned (§3.7) and reading the level out of the GLBs would mean downloading every example to draw a list. |
| `_vendor-merge.mjs` | `documents` is an owned manifest key, merged entry-wise by `path` exactly like `models`/`library`. Its paths already carry their folder, so — unlike the folder-relative legacy arrays — they are classified **unprefixed**; prefixing again would match no vendor glob and silently mark every customer document as ours. |
| `migrate-project-manifest.mjs` | Brings a manifest to schema 2: derives `documents[]` from the three arrays, writes the migration marker, and indexes `.scene.glb` bodies (preferring the GLB over a `.scene.json` sibling rather than listing the scene twice). Still **additive** on the Node side, and deliberately so: it is an offline tool that may run against a repository the browser has not opened, and removing a customer's arrays from outside the app is a decision the app itself makes on its first save. It writes no `documentsBaseline` — that field no longer exists. |
| `pull-customer-project.mjs` | Unchanged — it gates on `assertValidProject()` and inherits the above. |

`stableDocumentId()` exists twice, once in TypeScript and once in Node, and the
two must agree character for character or the same file would gain two
identities depending on which migrator saw it first.
`tests/migrate-project-manifest.node.test.ts` pins the agreement against the
TypeScript source rather than against a copied expectation.

---

## 4. Boot path: how a reload restores state

Sequence in [`src/main.ts`](src/main.ts):

```
1. Init RVViewer, register plugins (Layout Planner, etc.)
2. initSceneStore(viewer)              ← reads catalogue indexes
3. migrateLegacyAutosave()             ← one-shot legacy migration (idempotent)

4. Resolve which document/model to load:
   ┌──────────────────────────────────────────────────────────────┐
   │ a. ?doc=<doc_…>          → SceneStore.openDocument(id)       │
   │ a'. ?scene=<id>          → alias-resolve (rv-doc-alias) to a │
   │       document id, redirect the URL to ?doc=, then as (a).   │
   │       Covers pre-716 scn_ ids and doc ids alike — read-only  │
   │       route, nothing mints ?scene= for a document any more.  │
   │ b. ?scene=builtin:<file> → SceneStore.openBuiltin(url, label)│
   │ c. ?scene=empty          → SceneStore.openEmpty()            │
   │ d. (else) rv-scenes/active id → openDocument(activeId)       │
   │ d'. (else) project.json activeSceneId ("decision 24")        │
   │ e. (else) ?model=<url> + LS_KEY_MODEL + defaultModel + first │
   │       → SceneStore.openBuiltin(finalUrl, label)              │
   └──────────────────────────────────────────────────────────────┘

5. SceneStore.openDocument(id):
   - read the document body from the project
   - _resolveLoad(doc)       ← GLB body slot draft/<documentId>, then <documentId>  (resume!)
   - viewer.loadScene(sceneToLoad)
   - writeActiveId(doc.id)     ← the document id, NOT a draft id
   - updateUrlDocumentParam(doc.id)   ← mints ?doc=

6. SceneStore.openBuiltin(url, label):
   - scene = makeDraftScene(base, label)
   - _resolveLoad(scene)     ← GLB body slot draft/<baseKey>  (resume!)
   - viewer.loadScene(scene)
   - writeActiveId(null)       ← unsaved drafts don't claim the active slot
```

Both resume steps read a **GLB body**, not a localStorage op log: the
`rv-scenes/draft/…` and `rv-scenes/scene-draft/…` keys lost their reader in
plan-413 phase 6 and their writer in plan-397 phase 7 (§3.1b, §3.1c).

Step 5 is the key reload-survival mechanism for **saved documents with unsaved
edits**: the open path always prefers the per-document draft over the stored
body. Step 6 is the equivalent for **fresh drafts**.

#### A resolved body is bytes, never identity

Both resume steps hand `loadScene` a base pointing at a `blob:` object URL with
a random UUID. That URL is **where the bytes came from**; it is not what the
model *is*. `_resolveLoad` therefore returns the workspace's original built-in
URL as `identityUrl` alongside it, `loadScene(scene, trust, { identityUrl })`
forwards it, and `main.ts`'s loader + `RVViewer.loadModel` key everything that
answers "which model is this?" off it: the model-plugin lookup
([`ModelPluginManager.onModelLoading`](src/core/rv-model-plugin-manager.ts)),
`pendingModelUrl` / `currentModelUrl`, the camera-preset key, `LS_KEY_MODEL`,
the model selector, `?option=`, the signature-unlock name and the loading
overlay's caption. Only `downloadGlb` and `loadGLB` see the raw blob URL.

Without it the UUID *became* the identity, and the failure was total and silent:
`?scene=builtin:DemoRealvirtualWeb.glb` reloaded after the first autosave with
the geometry intact, the overlay captioned with the UUID, and not one of the
demo's HMI plugins registered — the lookup found no folder named
`4904a9e1-c63d-…`. It reads like a stale cache, which is the one thing it is
not. Note the direction: the *better* the transparent saving gets, the more
reliably every user has a body, and the more reliably this fires. Pinned by
[`rv-scene-body-identity.test.ts`](tests/rv-scene-body-identity.test.ts).

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
| **Authoritative model manifest** | `public/models.json` present | Replaces the catalogue wholesale — critical for private deploys. Since plan-735 there is no build-time glob under it: with no `models.json` and no private-models endpoint the catalogue is simply empty, and the project comes from `project.json` alone |
| **Local-filesystem model discovery** | A legacy working-folder handle is still granted (see §7.6) | Surfaces `.glb` files in that folder's `models/` subdirectory inside the Models panel. Read-only and on the way out — Settings → Backup → *Old Working Folder* copies the lot into the project |

None of these branches write to the Scene model; they only influence which
GLB the SceneStore is asked to open. Once `openBuiltin()` / `openScene()` is
called, the regular boot path takes over.

### 4.2 The legacy fallback path

If a `?model=` URL or `LS_KEY_MODEL` resolves and no `?scene=` was set, the
legacy default-model boot is now routed through `sceneStore.openBuiltin(...)`
rather than `loadModel(...)` directly. This was an explicit fix: the bare
`loadModel` path eventually called `markGlbActive(url, label)` which builds
a workspace with **empty baseline** — discarding any per-base draft that had
been autosaved. Routing through `openBuiltin` keeps the workspace on one path.

(The draft-restore half of that fix is gone: `openBuiltin` consulted the
`rv-scenes/draft/` slot until plan-413 phase 6 removed the reader. An unsaved
built-in workspace resumes through its GLB draft body (§3.1b) instead.)

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

## 6. Import / export of scenes

There is **no JSON scene import or export** any more (plan-413 phase 6).
`exportSceneJSON` / `importSceneJSON` wrote and read the full `RvScene` record,
which stopped being the body in plan-397: what they produced afterwards was a
catalogue row describing bytes it did not carry, so an exported file could not
be opened anywhere — including here.

The portable form is the file itself. **Export .glb…** writes the scene's body,
with every override already folded in (§6.1), and any GLB can be brought back
in through the normal import path. That is the same artefact a share link
carries, so "send it to a colleague" and "keep a copy" are one format.

### 6.1 Saving scene settings into the model

`SceneStore.saveSettingsIntoModel(name)` writes the working scene's property
overrides INTO a copy of its base GLB and adopts that copy as the new
baseline. It is the answer to "this configuration only exists in my
browser": after a write the settings travel with the file, and the scene
starts again with an empty op log.

**Where the user finds it.** In the `DocumentCard` menu. For one release this
function had no caller at all: its only entry point was `SceneActiveCard`,
which was written, finished and never mounted. Reactivating that card as
`DocumentCard` (plan-709 §2.1) is what made it reachable again — worth knowing
before assuming a feature is unused because nothing calls it.

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
- **Values that JSON would CHANGE are refused; a value it merely drops is not.**
  `JSON.stringify` turns `NaN` and `±Infinity` into `null`, and rewrites an
  `undefined` ARRAY ELEMENT to `null` — different values at the same place, so
  `UnrepresentableValueError` names the exact node → component.field and the
  file is not written. An `undefined` OBJECT PROPERTY is the opposite case:
  `{ topic: undefined }` serialises to `{}` and reads back as `undefined`, an
  exact round-trip. Since plan-422 the bake drops such a property with a
  `[scene-bake]` warning instead of refusing.

  That distinction was a real data-loss bug, not a nicety. The refusal is
  per FILE, so a single CONNECT signal bound without an MQTT topic aborted the
  whole draft autosave — and with it every other unsaved edit of the session,
  reported nowhere but the console. The cause is fixed at the source too
  (`omitUndefined` in `rv-omit-undefined.ts`, applied at the four signal-payload
  copy sites), so an absent optional now stays absent instead of travelling as a
  present empty key. A top-level `undefined` field value still fails: there is
  nothing left to write.
- **The whole transaction runs inside the op queue.** Fetching and writing
  takes seconds, and `applyOp` / `undo` / `redo` queue there too — draining
  the queue up front and then working outside it would let an edit apply
  mid-flight and then be erased by the empty op log the adoption installs.
  Scene *loads* bypass the queue, so the workspace is re-checked before
  adoption; a switch mid-write yields `scene-changed` and leaves the scene
  alone. Any failure after `writeDocument` deletes the file again — an orphan in
  `models/` is indistinguishable from a finished delivery.

The output is written through `ProjectBackend.writeDocument` to `models/<name>.glb`
(folder → disk, browser → OPFS, bundled → refused with a reason), then
reopened via `openBuiltin` — which reloads from the bytes just written and is
therefore also the cheapest proof that the write is loadable.

GLB export of a scene as a *download* is not implemented; baking targets the
project, which is where a delivery is assembled.

---

## 6.5 The Asset editor document (Editor mode)

The `editor` workspace mode authors the **GLB itself** rather than an overlay on
top of one. The document behind it is
**AssetDocument** ([`src/core/editor/rv-asset-document.ts`](src/core/editor/rv-asset-document.ts)) —
a facade over the same [`RvDocument`](src/core/ops/rv-document.ts) the scene
side uses (§2.1a), in `'asset'` mode. It is not a second document class and not
a second op log; what is its own is op construction, its base bytes and its
save path.

- **Ops** (`rv-asset-ops.ts`) — the asset-origin kinds of the one vocabulary:
  `importCad`, `transformNode`, `renameNode`, `deleteNode`, `setNodeVisible`,
  `createNode`, `reparentNode`, `addComponent`, `removeComponent`, `setField`,
  `unsetField`, `setMaterial`, `separateMesh`, `mergeMesh`, `composite`
  (§2.1 has the full table with the scene-origin kinds beside them). Structural
  deletes detach to a hidden trash group so undo re-attaches the original
  objects; CAD geometry is never inlined in ops (referenced by SHA-256, re-
  materialised via the private `CadGeometryProvider`).
- **Draft**: debounced autosave of the **op array** — not baked bytes, because a
  stack can have several dirty frames at once and baking is O(model). There is
  **one writer**, [`RvDraftAutosave`](src/core/ops/rv-document-drafts.ts), hung
  on the document's `onChanged` seam; the facade only decides which FRAME it
  points at. Every document writes the per-frame keyspace (IndexedDB store
  `frames`, key `<projectId>:<rootDocumentId>:<occurrence>`) — a document that is
  not in a stack gets its own ROOT frame rather than a shared fallback slot.
  Crash recovery
  ([`rv-editor-draft-recovery.ts`](src/core/editor/rv-editor-draft-recovery.ts))
  replays the op log over the re-loaded base; the offer names the frames a
  recovered stack descends from even when those carry no draft of their own.
  Autosave is **suspended** for the duration of an in-place test run (plan-410),
  so the slot keeps describing the pre-test authoring state rather than the
  materialised test scene.

  > **Release note (plan-710).** The legacy single draft slot (DB
  > `rv-asset-editor`, store `drafts`, key `current`) is **gone, and its content
  > is discarded rather than migrated** — a deliberate decision, not an
  > oversight. An editor draft left open by a build older than this one is no
  > longer offered by crash recovery. Nothing crashes and no other data is
  > touched: the slot is simply never read again. Up to plan-710 three op-draft
  > writers coexisted (this slot, the frame slot, and a hand-rolled debounce
  > inside `AssetDocument`) plus 374 lines of migration code that was never
  > wired to anything; keeping a fourth read path alive for a slot that only a
  > forced exit can populate was the more expensive answer.
- **Draft shelf** (plan-410 F3): a **second object store** `shelf` in the same
  database (`rv-asset-editor`, DB version 2), keyed by document id. There is
  only one main draft slot, so "keep my draft, open that other asset instead"
  cannot mean "leave it where it is" — the new document's next autosave would
  overwrite it. `shelveDraft()` moves it out of reach in **one readwrite
  transaction** over both stores (shelf put + main slot delete). It is the one
  function in that module that **rejects** instead of logging, and the caller
  may only open the requested asset once that transaction committed. Shelved
  drafts never open by themselves — the editor offers them (restore / discard /
  later) when it starts with no pending request and no main draft, and only an
  explicit discard deletes one.
- **Last edited asset** (plan-410 F2): localStorage key
  [`rv-editor-last-asset`](src/core/hmi/rv-storage-keys.ts), a versioned
  `{ v: 1, base, savedAt }` record. `base` is an `AssetBase` **identity**
  (library rel-path, or provider/source/asset ids) — never a URL, and never
  `kind: 'empty'`. Written on every successful open and on every save, read as
  the last fallback of the open chain. Reads are defensive: unknown schema
  version, corrupt JSON or an incomplete base all read as "no memory", and a
  stale reference that fails to load falls back to an empty document.

  **The editor's open chain**, in order:
  `pending request > main draft > shelf offer > last edited > empty`. A pending
  request *and* a main draft together raise the conflict dialog (continue draft
  / discard draft / open requested — the last one shelves first).
- **Save**: `GLTFExporter` bakes the live tree (geometry +
  `userData.realvirtual` incl. `CADLink`) into a binary GLB written to
  `<project>/library/Custom/<name>.glb` of the **active project** (+ thumbnail under
  `library/.thumbnails/Custom/`). There is exactly ONE save destination and
  one path to it (`saveDocument()`, plan-709 §2.2): the editor's second target
  — `<workfolder>/library/Custom/` — and its browser-download fallback are both
  gone. `downloadAssetGlb` survives as an explicit menu verb, not as what
  happens when a save quietly fails. The exporter writes `userData` into glTF
  `node.extras` — exactly the form the scene loader reads back, so the
  browser round-trip is symmetric. NOTE: Unity's exporter uses the
  `REALVIRTUAL` glTF extension form; browser-authored GLBs target the WEB
  loader.
- **Write-path seam**: the inspector routes through
  [`rv-edit-target.ts`](src/core/hmi/rv-edit-target.ts) — SceneStore ops
  outside the editor, AssetDocument ops inside. The editor never touches the
  `rv-scenes*` keyspace.

## 6.6 Save: one routing, two writers, and CAS from the load onwards

[`saveDocument()`](src/core/editor/rv-save-document.ts) is the one entry point
for **both** lineages. It takes either behaviour layer — `AssetDocument` or
`SceneStore`, discriminated by a `lineage` field — and one `decideSaveVerb()`
answers for both, so the three refusal sentences ("no project is open", "this
project ships with the application", "the open project is read-only") exist
once. Until plan-710 the scene half had its own verb function repeating them
clause for clause, plus its own no-op rule, its own "needs a name" branch and
its own error wrapping.

What is **not** merged is the protection. Each lineage keeps the writer that
carries its own plan-709 guarantees — destination bound before the bake and
verified after it, the whole transaction on the document's exclusive queue, the
op floor read before the bake, compare-and-swap, the per-backend write queue. The
scene branch therefore delegates into `SceneStore.save()`/`saveAs()` rather than
baking a second time here: the *routing* was doubled, never the safety.

One consequence is visible to the user. `SceneStore.save()` returns a
`SceneSaveVerdict` (`'saved' | 'no-op' | 'target-changed'`) instead of `void`.
Its two silent outcomes — the clean no-op, and the §2.2.1-1 discard when a load
replaces the workspace mid-write through `_installOps` — used to be
indistinguishable from success one level up, so the card said "saved" for a save
that adopted nothing. The guard already made that decision; it simply had no way
to report it.

**Compare-and-swap now starts at the READ.** Every write goes out with an
`expectedRevision`, and the token is the revision this session last saw for that
path. plan-709 named the gap it left open in its own module header: nothing
recorded a revision at *load* time, so the first save of a path formed its
precondition by reading the file at save time — which, if another tab had
written in between, meant reading THEIR bytes and adopting THEIR revision as the
expectation. The compare passed and the overwrite was silent, in exactly the
case it was most needed: open a file, work on it, save once.

`noteLoadedRevision()` closes it. The editor's open path calls it for every
path-addressed base (`projectDocument`, `libraryGlb`, and a `referencedAsset`
reached by path) through the one funnel `resolveProjectRelativeUrl`, so the
ledger holds the revision of what the user is actually looking at. A foreign
write between load and first save is now a **conflict**, and the stored bytes
stay the other writer's. It never throws and never fails an open: a revision
that cannot be taken leaves the ledger empty, which degrades to the plan-709
behaviour. The ledger is keyed by `<backendId>\0<relPath>`, so a project switch
cannot leak a revision from one project into a write against another.

**A bound scene document routes by its BASE, not by its caller** (plan-711).
When the editor holds the scene's document (§2.1c), Save from the editor — the
button, Ctrl+S and the MCP save tool alike — reaches `saveDocument()` through
`AssetDocument`; a `document` base is then answered by the SCENE
writer unconditionally: `SceneStore.save()`, body slot plus the document file,
addressed by its `documentId`. It is never the `relPath` / `exportAssetGlb` path, which
would drop an authored GLB into `models/` and leave the scene untouched. If the
store no longer holds that scene, the save is **blocked** rather than written
into whatever scene is open now. `decideSaveVerb` reports the same thing up
front: verb `save`, no `relPath` (a scene has none).

Pinned by `save-document-routing.test.ts` (identity routing + concurrency),
`save-document-scene-frames.test.ts` (the scene lineage incl. load-during-save),
`mixed-log-save.test.ts` (the bound routing + autosave suspension) and
`load-records-revision.test.ts` (the CAS window).

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
| `rv-share-session` | `core/share/rv-share-session.ts` | **Sender** side: magic-link session (token, e-mail, expiry). Expired reads as absent |
| `rv-share-draft` | `core/share/rv-share-session.ts` | **Sender** side: the share dialog form, kept across the sign-in mail round trip. Consent to a *superseded* terms version is deliberately not restored |
| `rv-shared-bookmarks` | `core/share/shared-asset-bookmarks.ts` | **Receiver** side: shared links kept via "Add to my library" — the only key a shared link may cause (§3.5b) |

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
| `rv-layout-active-tab` | Last-active catalog tab URL. Still written for a catalog pick, so a catalog can stay the default; it cannot express the project or an AM connection, which is what the key below is for. |
| `rv-planner-active-library` | Last-active Library-window tab, in the registry namespace (`project:<projectId>` / `global:<url>` / `am:<connId>`). Read FIRST; a legacy bare URL in `rv-layout-active-tab` is re-prefixed on read (plan-723) |
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
| `workfolder` | `HANDLE_KEY_WORKFOLDER` — **`@deprecated`, read-only** | The legacy single working folder. **Nothing writes to it any more** (plan-709 §2.6): the Custom-library save, MCP captures, MCP imports, planner thumbnails and the local-folder catalog all went to the project. The slot survives so an existing install can still be READ — by the boot model scan and by Settings → Backup → *Old Working Folder*, which copies the whole tree into the open project and never deletes the source |

Handles survive reloads but the browser may prompt the user to re-grant
permission.

**Access is not read-only.** The two modes coexist deliberately:

- The legacy `workfolder` picker is `mode: 'read'`, and
  `ensureWorkFolderPermission()` queries/requests `'read'`. Since plan-709 that
  is no longer a convenience but the whole contract: there is no write path to
  that folder left in the codebase.
- Project and workspace folders go through `selectFolderForKey()`, which picks
  with **`mode: 'readwrite'`**, and `ensureHandlePermission()` defaults to
  readwrite. This is what lets a project write models, library assets and the
  baked GLB of §6.1 back to disk. A separate upgrade path lifts an existing
  read-only handle to readwrite.

Companion key in localStorage: `rv-local-folders` carries
`{ displayName, lastAccessed }` so the Settings UI can name a folder without
forcing a permission prompt.

The legacy working folder is read by the main model selector (`models/`) and by
the migration in Settings → Backup → *Old Working Folder*. The Layout Planner's
local-folder catalog — the other reader — went with the write paths (§2.6 of
plan-709): a library on this machine is a **project** now, opened from Projects.

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
`rv-scenes/*` data. A scene travels as its GLB (§6).

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

- `rv-scenes-index` and every `rv-scenes/<id>` row (legacy since plan-716, §2.0-00)
- Whatever is left in the two dead draft slots (`rv-scenes/draft/<base>`,
  `rv-scenes/scene-draft/<id>` — §3.1)
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
| [`src/core/ops/rv-document.ts`](src/core/ops/rv-document.ts) | `RvDocument` — **the** op log: queue, transactions, coalescing, undo/redo, history cap, dirty derivation |
| [`src/core/ops/rv-unified-ops.ts`](src/core/ops/rv-unified-ops.ts) | The one op vocabulary (25 primitives + `composite`) and `RV_OP_ORIGIN` |
| [`src/core/editor/rv-save-document.ts`](src/core/editor/rv-save-document.ts) | The ONE save path — routing for both lineages, the session revision ledger, compare-and-swap from the load onwards (§6.6) |
| [`src/core/ops/rv-document-stack.ts`](src/core/ops/rv-document-stack.ts) | Frames, breadcrumb, dirty matrix, staleness, isolation intent |
| [`src/core/ops/rv-document-drafts.ts`](src/core/ops/rv-document-drafts.ts) | Per-frame draft keyspace (op arrays, project-namespaced keys) |
| [`src/core/hmi/scene/scene-store.ts`](src/core/hmi/scene/scene-store.ts) | `SceneStore` — facade over one `RvDocument`: workspace lifecycle, body persistence, autosave timer, `hasUnpersistedWork()` (§3.5c) |
| [`src/core/hmi/rv-dirty-dot.tsx`](src/core/hmi/rv-dirty-dot.tsx) | `DirtyDot` — the one unsaved-work mark, `warning.main` (§3.5c) |
| [`src/core/editor/rv-asset-document.ts`](src/core/editor/rv-asset-document.ts) | `AssetDocument` — the other facade over one `RvDocument` (§6.5) |
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
| [`src/core/hmi/scene/DocumentCard.tsx`](src/core/hmi/scene/DocumentCard.tsx) | The one document card — Save / Discard / Undo / Redo, in the hierarchy header and as the dashboard hero |
| [`src/core/project/rv-workfolder-migration.ts`](src/core/project/rv-workfolder-migration.ts) | One-way copy of a legacy working folder into the open project (resumable, never deletes the source) |
| [`src/main.ts`](src/main.ts) | Boot path: URL routing → SceneStore → fallback chain |

For a deeper dive into the design rationale (why the op log, why two autosave
slots, why composites can't nest, and — where the two lineages disagreed —
which answer was kept and why), the inline doc comments in `rv-document.ts`,
`rv-unified-ops.ts`, `rv-scene-edits.ts` and `scene-store.ts` are the
authoritative source. They were written as the respective plans were being
implemented and explain the trade-offs that aren't visible from the code alone.

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
