# Projects, documents and saving

> **Applies to:** Community project and storage workflows; folder access requires a compatible browser and secure context.
> **Reference baseline:** 6.3.43, reviewed 2026-09-16.

## What belongs where

A project groups documents and their related files. Its `project.json` manifest
uses `schemaVersion: 2` and a `documents[]` list. Each document has an identity and
a path relative to that project. Folder names such as `models/`, `scenes/` and
`library/` organize files; they do not determine what a document can do.

The bundled example is `public/demo-realvirtual/`. The shared component catalogue
is `public/library/catalog.json`; a project's `libraries[]` subscribes to catalogues.
Do not prepend the demo project's path to the app-level library URL.

| Project location | Reading and saving |
|---|---|
| Linked local folder | Browser permission grants file access; explicit saves write project files |
| Browser project | Data stays in this browser profile at this origin; storage is not a backup |
| Bundled/HTTP project | Reads published files; edits must be saved into a writable project |
| Maintainer private project | Optional separate repository; not required to create a Community project |

Use **New** in the dashboard's projects list to create a folder project, or **Add**
to link an existing folder. These actions require browser folder access. An app
opened without that capability can still use its browser workspace.

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

Agents use `web_document_info_get` / `web_document_info_set`, which address any
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
