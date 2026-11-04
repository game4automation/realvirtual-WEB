# Projects, documents and saving

> **Applies to:** Community project and storage workflows; folder access requires a compatible browser and secure context.
> **Reference baseline:** 6.3.43, reviewed 2026-09-16.

## What belongs where

A project groups documents and their related files. Its `project.json` manifest
uses `schemaVersion: 2` and a `documents[]` list. Each document has an identity and
a path relative to that project. Folder names such as `models/`, `scenes/` and
`library/` organize files; they do not determine what a document can do.

The bundled example is `public/demo-realvirtual/`. The shared realvirtual library is
itself a project: `public/library/project.json` (id `prj_realvirtual_library`), served
app-level at `<BASE_URL>library/`. A project names its libraries by project id in
`libraries[]` — see [Libraries are projects](#libraries-are-projects-plan-778). Do not
prepend the demo project's path to the app-level library location.

| Project location | Reading and saving |
|---|---|
| Linked local folder | Browser permission grants file access; explicit saves write project files |
| Browser project | Data stays in this browser profile at this origin; storage is not a backup |
| Bundled/HTTP project | Reads published files; edits must be saved into a writable project |
| Maintainer private project | Optional separate repository; not required to create a Community project |

Use **New** in the dashboard's projects list to create a folder project, or **Add**
to link an existing folder. These actions require browser folder access. An app
opened without that capability can still use its browser workspace.

### Linked project folders (plan-743)

There is no workspace root. The dashboard lists every *linked* project folder,
flat and uncapped: one directory handle per project in IndexedDB
(`projectfolder:<id>`) plus a display row in the `rv-project/linked` list
(`rv-project-linked.ts`). Permission is requested when a project is opened, not
when the list is shown; a lapsed grant shows a lock icon instead of hiding the
project. Unlinking (`unlinkProject()`) removes a project from the list; closing a
project does not. `web_project_list` / `web_project_open` work on the same list.

**Add** classifies the picked folder with one listing of its direct children
(`rv-project-add.ts`, `detectOpenTarget()` in `rv-project-open.ts`):

| Picked folder | Result |
|---|---|
| Has `project.json` (or `.bak`) | Linked as one project; child projects only appear as a hint. An unreadable manifest is reported and nothing is written |
| No manifest, but subfolders with one (folder of projects) | Every child project is linked in one step |
| Neither (plain folder) | Recursive, uncapped `.glb` scan (`scanGlbTree()` in `rv-project-scan.ts`) with a visible counter and Cancel. Subfolders that are projects themselves are not descended into and are reported for separate linking. Only after a complete scan does `seedProjectFromScan()` write a new `project.json` into the picked folder |

## Libraries are projects (plan-778)

Any project can be a library of another project. Project A lists its libraries in
`project.json` as `libraries: [{ projectId, label?, hint? }]`; B's own `project.json`
needs no change and is never written while B is used as a library (the one
exception is an explicit **Edit in library**, below). Legacy `{ url }` entries and
bare strings are still read; every writer (attach, detach, migration, dashboard)
keeps entries and keys it does not understand.

<figure>
<svg class="rv-d" viewBox="0 0 760 250" role="img" aria-labelledby="lp-title lp-desc">
<title id="lp-title">Project A uses library B, which needs library C</title>
<desc id="lp-desc">Project A, the open project in a linked folder, lists library B by project id. B is a linked folder on this computer, read-only to A; its documents are placeable in A. B lists library C, which is published at a hosted URL; C is loaded because B needs it, but it is not placeable in A. The realvirtual library ships with the application at BASE_URL library and is always resolvable; it is placeable only when A lists it.</desc>
<style>
.rv-d text { font-family: var(--sl-font, system-ui, sans-serif); fill: var(--sl-color-white, #1f2937); font-size: 14px; }
.rv-d .t-title { font-weight: 600; font-size: 15px; }
.rv-d .t-small { font-size: 12.5px; fill: var(--sl-color-gray-3, #4b5563); }
.rv-d .t-mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; fill: var(--sl-color-gray-2, #374151); }
.rv-d .t-accent { fill: var(--sl-color-accent, #b45309); }
.rv-d .box { fill: var(--sl-color-gray-6, #f3f4f6); stroke: var(--sl-color-gray-5, #9ca3af); stroke-width: 1.2; }
.rv-d .box-accent { fill: var(--sl-color-accent-low, #fef3c7); stroke: var(--sl-color-accent, #b45309); stroke-width: 1.4; }
.rv-d .frame { fill: none; stroke: var(--sl-color-gray-4, #9ca3af); stroke-width: 1.2; stroke-dasharray: 5 4; }
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
<rect class="box-accent" x="0" y="20" width="200" height="120" rx="8"/>
<text class="t-title t-accent" x="12" y="44">A — open project</text>
<text class="t-small" x="12" y="64">linked folder, writable</text>
<text class="t-mono" x="12" y="88">libraries: [</text>
<text class="t-mono" x="12" y="104">  { projectId: "prj_b" }</text>
<text class="t-mono" x="12" y="120">]</text>
<rect class="box" x="280" y="20" width="200" height="120" rx="8"/>
<text class="t-title" x="292" y="44">B — direct library</text>
<text class="t-small" x="292" y="64">linked folder, read-only</text>
<text class="t-small" x="292" y="80">placeable in A</text>
<text class="t-mono" x="292" y="104">folder:prj_b</text>
<text class="t-small" x="292" y="124">lists { projectId: "prj_c" }</text>
<rect class="box" x="560" y="20" width="200" height="120" rx="8"/>
<text class="t-title" x="572" y="44">C — needed by B</text>
<text class="t-small" x="572" y="64">hosted URL (hint)</text>
<text class="t-small" x="572" y="80">resolvable, not placeable</text>
<text class="t-mono" x="572" y="104">remote:https://…/</text>
<path class="line" d="M200 80 H272"/><polygon class="head" points="278,80 269,75 269,85"/>
<text class="t-small" x="210" y="72">by id</text>
<path class="line" d="M480 80 H552"/><polygon class="head" points="558,80 549,75 549,85"/>
<text class="t-small" x="490" y="72">by id</text>
<rect class="frame" x="0" y="170" width="480" height="64" rx="8"/>
<text class="t-title" x="12" y="194">realvirtual library — built-in</text>
<text class="t-mono" x="12" y="216">&lt;BASE_URL&gt;library/project.json · prj_realvirtual_library</text>
<path class="line-deny" d="M100 140 V164"/>
<text class="t-small" x="500" y="194">always resolvable;</text>
<text class="t-small" x="500" y="212">placeable only when A lists it</text>
</svg>
<figcaption>A names B, B names C — by project id only. Each library is read from wherever it lives on this computer.</figcaption>
</figure>

**References are by id.** A placement made from a library project writes an
`AssetReference` of `{ assetId: <document id>, providerId: 'library-projects',
sourceId: <library project id> }` and no `path`. Such a qualified reference
resolves in that one library and nowhere else — not in A's manifest, not by a
stored path, not by a cached URL; a missing library is a placeholder. An unqualified
(legacy, Unity-exported) reference searches every source: canonical document ids
first, then `aliases`, then A's manifest, then its path. A `global` qualifier that
names the realvirtual catalogue URL resolves in `prj_realvirtual_library`. This is
the one exception to the containment rule: a library reference may leave the
project only by identity, never by path.

**Locations, in order** (`src/core/library/library-project-loader.ts`, backends in
`library-project-backends.ts`). The first that holds a `project.json` with the same
id wins; a location that holds another project is an error naming both.

| # | Location | Backend id |
|---|---|---|
| 0 | `prj_realvirtual_library` only: the app-level `<BASE_URL>library/` | `remote:<url>` |
| 1 | A linked folder (`projectfolder:<id>`), read grant only — never a prompt; no grant = **locked** | `folder:<projectId>` |
| 2 | A browser project of that id stored in this browser | `browser:<projectId>` |
| 3 | The `hint` URL (3 s timeout); a GitHub URL without `project.json` falls back to a repo scan whose ids answer as aliases | `remote:<url>` |
| 4 | A relative hint `libraries/<id>/project.json`, against the open project's own location (a delivered or packed copy) | `folder:<projectId>` / `remote:<url>` |

Backends are read-only and never activated; their ids are unique per library
project, so two libraries in same-named folders never share a save ledger. A
library project needs `project.json` and nothing else (no `models.json` is probed).

**States.** On a project switch every listed library appears as `pending`
synchronously, before anything awaits; opening A never waits for a library. A
library then becomes `ready`, `locked` (folder known, read grant lapsed), `unknown`
(not on this computer) or `error`. Each unavailable library is a Problems row
`library-unavailable:<projectId>` with **Grant** (`library.grant`,
`requestPermission({mode:'read'})` as the first statement of the click) or **Locate
folder…** (`library.locate`; the picked folder must carry the same id, then it is
linked like any project and the library is located again). One summary line per
project open points at the rows. A ready library whose reads start failing turns
`error`; placeholders come back without a reload when their library becomes ready.

**Transitive libraries.** B's own `libraries[]` are loaded too (deduplicated by id,
depth ≤ 16, cycles and self-references harmless). Only A's direct libraries are
placeable; the others are listed as "needed by B". The realvirtual library is always
resolvable — a GLB that references it works in any project — but placeable only when
A lists it.

**Adding and removing.** *Add library…* has a **Projects** tab (known projects:
the realvirtual library, linked folders, browser projects), **Link folder…** and
**From URL…** (folder actions only where `showDirectoryPicker` exists); it writes
`{ projectId, label, hint }`. MCP: `library.attach` / `library.detach` with
`projectId` (or a legacy `url`). Removing a library that still has placements asks
first and names the count; the placements become placeholders, nothing is deleted,
and adding the library again restores them.

**Migration of old manifests.** The first manifest-writing save of a project converts
realvirtual catalogue URLs (bundled, the realvirtual hosts, GitHub) to
`{ projectId: 'prj_realvirtual_library', hint }`, adds the library where `libraries[]`
is absent, and records the marker `rv-project/library-project-migration` in the same
write. External catalogue URLs stay as they are. A **customer** project
(`kind: customer`) is never written on its own: it gets a Problems row
`library-reference-update:<projectId>` with **Update** (`library.migrate`), and the old
URL keeps resolving until then.

**Editing library content.** Inside A a library is read-only; per-placement changes
are `AssetOverrides`. The Inspector of a library placement shows *From library:
<label>* with three actions:

- **Open library** — the Projects dashboard with the document selected.
- **Edit in library** — a confirmation ("Save changes into library '<label>'? Every
  project that uses it gets the change."), then `requestPermission({mode:'readwrite'})`
  on B's folder inside that click, then the editor opens B's document as a
  `libraryDocument` base. Save writes into B through a writable backend with B's id
  (`expectedRevision` from the open), updates B's row (`sha256`, `sizeBytes`) and
  re-reads B, so A's placements pick up the new version. Drafts of that document are
  keyed by B's project id. Only a linked-folder library can be edited; the built-in
  realvirtual library, hosted and GitHub libraries, browser-stored libraries and a
  delivered `libraries/<id>/` copy are refused with a reason. A library document
  reached by descending into a placement asks the same question on its first Save.
- **Copy into project** — B's document becomes a new document of A
  (`copiedFrom: { projectId, documentId }`, at A's root) and the placement now uses
  it, at the same transform, as one Undo step. Signal mappings and snap pairings of
  the replaced placement are not carried over.

**Pack and delivery.** *Pack with libraries…* (project menu, folder projects) writes a
copy of A plus trimmed copies of every library it uses — transitively, only the
documents that are referenced, bytes unchanged — under `libraries/<id>/`, and rewrites
the hints in the copy to `libraries/<id>/project.json`. Deliveries do the same; see
[Deployment](doc-deploy.md#libraries-in-deliveries-plan-778).

## Save, autosave and export

| Action or state | What it means |
|---|---|
| Live scene and undo history | In-memory editing state; do not treat it as a saved file |
| Autosave | Debounced working GLB body in the project backend/OPFS; recovery state, not a portable export |
| Save | Commits the current document through its writable project; wait for success |
| Save as… | Creates a separate saved document, with its own project entry |
| Export/download GLB | Portable model file; does not automatically carry sibling PDFs, scripts, settings or the whole project |
| Copy project folder | Moves the manifest and related files together; reopen the folder on the destination |

Runtime values, such as a simulation counter or an external PLC value, are not
automatically authored model properties. A successful Save does not imply that
every transient runtime value will be restored next time.

Small pointers and preferences live in localStorage. Current draft geometry is a
GLB body in OPFS/project storage, not the retired localStorage operation log. The
detailed storage contract is in [Persistence](doc-persistence.md).

## Verify and recover

After saving, reload and reopen the document. Confirm its saved geometry/settings
before closing the original working session. A successful write emits
`document-saved`; a failed write must be resolved before treating the work as safe.

If a linked project cannot open, check that the folder still exists and regrant
browser permission. Re-link a moved folder through the projects list. If a
manifest write was interrupted, preserve both `project.json` and
`project.json.bak` before investigating; do not overwrite a good copy blindly.

If work appears missing, first check the project, document, browser profile and
origin. `localhost:5173`, `localhost:4173` and a hosted domain have separate browser
storage. Return to the original origin to recover/export a browser-only document.

If a reload says that a link points at a document no longer in this project, check
which project is selected before treating the document as deleted. Open the project
you saved into from the dashboard, then select its document. A `?doc=` ID from your
browser workspace cannot identify a document inside the bundled demo project.

Do not clear site data while relying on an unsaved draft: browser data clearing can
remove OPFS, IndexedDB and preferences together. Removing a project link, deleting
a project/document, and resetting preferences are different operations; read the
specific confirmation dialog and keep a folder copy or export before deletion.

## Document description

A document can carry a short description of what it is: a one-line **summary** and a
Markdown **description**. It is stored inside the GLB, in the default scene's
`extras.realvirtual.DocumentInfo` block beside `Classification`, so it travels with
every copy, export and share link. The block records `updatedAt` and, when you set
a display name in the Multiuser settings, `updatedBy`.

- **Edit** it in the dashboard's detail pane, under **Classification**. There is no
  Save button: leaving a field writes it, **Enter** in the summary writes it, and
  selecting another document writes a pending edit first. A write that fails keeps
  your text and shows **Retry**; an edit left over from a project you have since
  closed is refused rather than written into the project that is open now.
- **Read** it by hovering a document card: after a short delay a tooltip shows the
  preview picture, the summary and the first paragraph. On a touch device a
  chevron beside the name expands the same text inline.
- **Read-only** documents (bundled, delivered) show the description as text and
  cannot be changed. A document without a description shows nothing extra — every
  model exported from Unity starts that way; Unity does not author the block.

The manifest row caches the block (`documents[].documentInfo`) so lists and
tooltips never open the GLB. The file always wins: when a project opens, a changed
file is re-read and the cached block is replaced, never merged. A row carries
`extrasScan: 2` once its cached stats were recorded by a scan that read the
description; rows without it — every manifest written before this feature — are
re-read (header only) on each open until the next regular manifest write stores
the marker. Opening a project never writes.

Agents use `web_query("document.infoGet", {document})` / `web_document_info_set`, which address any
document of the open project by id or path.

**Known limitation.** If the same document is open in the asset editor while its
description is changed from the dashboard or by an agent, a later Save in the
editor writes the description it loaded and undoes that change. The same applies
to the classification. `web_document_info_set` reports `openInEditor: true` in
that situation.

## Share or move

For a folder project, save first, then copy the complete folder including its
manifest, documents, plugin source and compiled siblings, PDFs and other referenced
files. The recipient opens it with **Add** and grants access/code consent as needed.
For browser-only work, export the required documents before clearing or changing
the browser profile. A bookmarked `?doc=` link selects a document of a project
available to that viewer; the bookmark does not contain the project bytes.

For a hosted project, preserve paths and letter case and test all HTTP requests.
The bundled demo is served below `demo-realvirtual/`; some customer/foreign-host
deployments instead use a manifest at the deployment root. Those layouts are
distinct. See [Deployment](doc-deploy.md) for the channel-specific contract.

## See also

- [Getting started](doc-getting-started.md)
- [Runnable project plugin](doc-project-plugin-example.md)
- [Storage architecture](doc-persistence.md)
- [Migration](doc-migration.md)
