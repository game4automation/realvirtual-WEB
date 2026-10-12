# Getting started with Community

> **Applies to:** standalone Community source checkout. Unity, CONNECT and the private repository are optional.
> **Reference baseline:** 6.3.43, reviewed 2026-09-16.

## Install and start

Use Git, npm and a supported Node.js LTS release (Node 22 or 24). Run the following
from a terminal. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

```bash
git clone https://github.com/game4automation/realvirtual-WEB.git
cd realvirtual-WEB
npm ci
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`. Use Chrome
or Edge on localhost for the folder-project walkthrough: it needs the browser's
File System Access API. Other supported browsers can use browser storage and
imported GLBs, but may not offer **Add** or **New** folder-project actions.

On the first visit, the welcome screen asks which application to open. Choose
**Open demo scene** for the Community HMI walkthrough. Commercial authoring cards
on a welcome screen do not add those modules to your checkout.

The bundled demo comes from `public/demo-realvirtual/project.json`. Its
`documents[]` list declares the files available to the project. The component
library lives separately under `public/library/`. A file copied into
`public/models/` does not automatically appear in the project.

The hosted realvirtual demo can include commercial modules absent from this
checkout. See the [edition comparison](README.md#community-edition-vs-commercial).

## Open a model and save your own project

1. Open the project dashboard. In its projects list, choose **New**, select a
   parent folder, enter a project name and choose **Create**. The app creates a
   project folder, manifest and an initial document.
2. Use the import dialog's **GLB File** tab to choose a GLB. For a reproducible
   small model, run the [project example](doc-project-plugin-example.md) and use
   its generated `triangle.glb`.
3. Save the document with **Save** or **Save as…** and wait for completion. If you
   started from the read-only demo, select a writable project in the save flow.
4. Close and reopen the page at the same origin. Open your project and its saved
   document. Regrant folder access if the browser asks. Confirm that the model
   and saved changes are present.

You can also choose **Add** in the projects list to open an existing folder with
`project.json`, including the example. A browser project stores data within this
browser profile and origin; it is not a folder backup. See
[Projects and saving](doc-projects.md) before moving or clearing data.

## Build and host

```bash
npx tsc --noEmit
npm run build
npm run preview
```

Open the preview URL, normally `http://localhost:4173`. Copy the **entire** `dist/`
directory to your static HTTP(S) host, preserving subdirectories. The default build
uses its configured base path; if hosting below a subpath, set Vite's base to that
path when building and test there. Do not open `index.html` through `file://`.

Browser projects at the dev origin do not appear at the preview/production origin.
Reopen the same folder project at the new origin, or import/export the documents.
For a directly hosted model, use `?glb=` with its HTTP(S) URL; a cross-origin model
host must permit CORS. The host serves files and cannot save browser edits back to
its disk. For hosted project manifests and customer deployment variants see
[Deployment](doc-deploy.md) and [Projects](doc-projects.md).

## Check the checkout

```bash
npm run docs:check
npx playwright install chromium
npm run test:node
npm test
```

`npx tsc --noEmit` is the Community type check. `npm run typecheck` is a maintainer
check requiring the private sibling. `npm run deploy` is the realvirtual CDN
publishing pipeline; Community self-hosting uses the local build above.

| Symptom | Check |
|---|---|
| Model file exists but no document appears | Register it in `documents[]` or import through the app; no folder auto-discovery |
| Folder buttons are missing | Use Chrome/Edge in a secure context such as localhost or HTTPS |
| Model/manifest request fails | Network panel: exact path and case, HTTP status, JSON content and CORS |
| Project opens but custom code does not | `scriptRef`, compiled `.js` sibling, project code consent, browser console |
| Work seems missing after switching server | Browser storage is scoped to origin; return to the old origin or reopen the folder |
| Commercial toolbar is missing | Check edition and enabled modules; installing Community does not enable commercial features |

## Next steps

- [Project plugin example](doc-project-plugin-example.md)
- [Embedding in another website](doc-embedding.md)
- [Debugging](doc-web-debugging.md)
- [Migration notes](doc-migration.md)
