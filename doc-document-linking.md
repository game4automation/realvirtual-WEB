# Document Linking System

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

realvirtual WEB supports linking PDF documents and AASX (Asset Administration Shell) packages to 3D scene nodes. Linked documents appear in the tooltip and can be opened in a built-in PDF viewer overlay.

## Architecture

Document linking consists of two phases:

1. **Build-time**: A script scans a folder of documents and generates a JSON index mapping identifiers (article numbers, AAS IDs) to file paths.
2. **Runtime**: A plugin loads the index on model load, matches nodes by metadata, and attaches `_rvPdfLinks` entries to `node.userData`.

The tooltip system automatically renders PDF links for any node that has `_rvPdfLinks` in its userData.

> **Not a document link: a GLB `AssetReference`.** A node that references another GLB asset is a
> *placement* of that asset, not a link to a document — at runtime the viewer materialises it
> through the placement instancer, recursively (plan-757 Phase 2: nothing is grafted at runtime;
> the asset editor is the one authoring load that still composes). Document links attached to nodes
> INSIDE a placed asset resolve on `layout-content-added` like any other placed content; a nested
> placement (a reference inside a placed asset) is content of its record's placement, and an edit
> under it is refused by name ("Open the referenced asset"). See `doc-node-paths.md` §9.

## Document Sources

### 1. AASX Packages (AAS Link Plugin)

AASX files contain Asset Administration Shell data with embedded PDF documents. The built-in `aas-link` plugin handles this automatically: on model load it pre-fetches the AASX packages referenced by the loaded scene, extracts the PDFs from the Documentation submodel, and attaches them as blob-based entries in `node.userData._rvPdfLinks`.

**What actually ships in `public/aasx/`:**

```
public/aasx/
├── index.json                      # AAS id → package, built by build-aasx-index.mjs
├── 23_Festo.aasx                   # Festo EPCC-BS-32-100-3P-A  (pneumatic cylinder)
├── 24_Festo.aasx                   # Festo EMME-AS-40-M-LV-AS   (servo motor — the DEFAULT)
├── 25_BoschRexroth.aasx            # Bosch Rexroth ctrlX DRIVE MS2N
└── 26_SEW_KA47-DRN90M4.aasx        # SEW KA47-DRN90M4 gearmotor
```

**Build the index:**
```bash
node scripts/build-aasx-index.mjs
```

The index maps the **AAS id** (as authored on the Unity `AASLink` component and carried in `rv_extras`) to the package that holds it:

```json
{
  "http://smart.festo.com/aas/1234567890": {
    "file": "24_Festo.aasx",
    "idShort": "Festo_EMME-AS-40-M-LV-AS"
  }
}
```

`AasIndexEntry` fields: `file`, `idShort`, and the optional `demoOnly` / `demoNote` described below.

> ### ⚠️ `26_SEW_KA47-DRN90M4.aasx` is gitignored
>
> That package is **127 MB — over GitHub's blob size limit** — so it is listed
> in `.gitignore` while the tracked `index.json` still references it. The
> consequence is concrete and worth stating plainly:
>
> - On the **deployed demo**, `?option=sew` works (the file is uploaded with the build).
> - In a **fresh clone of the public mirror**, the file is absent, so `?option=sew`
>   resolves an index entry pointing at a 404 and the SEW AAS shows no documents.
>
> This is expected, not a broken checkout. If you need it locally, obtain the
> package separately and drop it into `public/aasx/`.

#### Supplier variants — the `?option=` swap

The Demo ships **one** GLB whose servo motors are authored against the Festo
motor AAS. The Bosch Rexroth and SEW packages are reachable as *variants of the
same GLB*, not as separate models — a mechanism worth understanding before you
copy this pattern:

| Piece | File | Role |
|---|---|---|
| `modelOptions` | `src/plugins/models/DemoRealvirtualWeb/model-options.ts` | **Deliberately empty.** Three near-identical rows in the model selector were more confusing than useful, so the variants are not listed in the UI at all. |
| `deepLinkOptions` | same file | `[{ id: 'bosch' }, { id: 'sew' }]` — declares which `?option=` ids this base model understands, so a foreign one is dropped instead of leaking onto the next model. |
| `applyModelOption()` | `src/plugins/models/DemoRealvirtualWeb/index.ts` | Does the actual work: `remapAasLink()` re-points every servo-motor AAS to the chosen supplier. |
| `ModelOptionPlugin` | `src/plugins/models/model-option-plugin.ts` | Generic carrier — reads the active `?option=` and calls the model's `applyModelOption`. |

So the variants are **deep-link only**:

| URL | Motors resolve to |
|---|---|
| *(no parameter)* | Festo `EMME-AS-40` — the default |
| `?option=bosch` | Bosch Rexroth ctrlX DRIVE MS2N |
| `?option=sew` | SEW KA47-DRN90M4 |

Two details that are easy to get wrong when reusing this:

- **The no-option case is not a no-op.** Some motor nodes ship hard-wired to a
  non-default supplier inside the exported GLB. `applyModelOption(viewer, null)`
  therefore *normalizes them back* to the Festo motor AAS, so the base demo is
  reliably single-supplier and SEW/Bosch appear only behind an explicit option.
  Remapping from *every* known supplier id (not just the default) is also what
  makes the swap idempotent.
- **`ModelOptionPlugin` MUST be registered first.** In
  `DemoRealvirtualWeb/index.ts` it is the first entry in the plugin array,
  ahead of `AasLinkPlugin`. Plugins receive `onModelLoaded` in registration
  order, and `AasLinkPlugin` **pre-parses the AASX packages for the AAS ids it
  finds on the nodes**. If the remap has not run yet, it pre-parses the *old*
  supplier's packages and the swap silently does not take effect. Any plugin
  that rewrites `rv_extras` the way `ModelOptionPlugin` does has to go first
  for the same reason.

#### Demo-only packages — the `demoOnly` banner

Not every AASX in a demo comes from the supplier. A package can be flagged so
the AAS panel renders an amber warning banner —
*"Demo only — not validated by the supplier."* — above its content.

Two ways to set the flag, checked in this order (`resolveDemoNote()` in `aas-link-plugin.tsx`):

1. **A qualifier inside the AASX** — preferred, because it travels with the package:
   ```xml
   <Qualifier type="DemoOnly" value="true"/>
   <Qualifier type="DemoNote" value="Reconstructed from the public datasheet."/>
   ```
   `DemoOnly` accepts `true` / `1` / `yes` (case-insensitive); `DemoNote` overrides the default text.
2. **An `index.json` fallback** — for packages you cannot modify:
   ```json
   {
     "https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001": {
       "file": "26_SEW_KA47-DRN90M4.aasx",
       "idShort": "SEW_KA47-DRN90M4",
       "demoOnly": true,
       "demoNote": "Demo only — not validated by the supplier."
     }
   }
   ```

The qualifier wins when both are present. When neither is set, no banner renders.

### 2. Standalone PDF Links (Model Config)

Map PDFs to nodes by path using the model's sidecar JSON (`modelname.json`) or `settings.json`:

```json
{
  "pluginConfig": {
    "aas-link": {
      "pdfLinks": {
        "Robot/Arm": "pdf/robot-arm-manual.pdf",
        "Conveyor/Motor": "pdf/motor-datasheet.pdf"
      }
    }
  }
}
```

PDFs are served from `public/pdf/` (or any path relative to the app root).

### 3. Metadata-Based Document Matching (Custom Plugin)

For large document libraries organized by article number or part ID, create a custom plugin that:
1. Loads a JSON index mapping identifiers to document paths
2. Parses node metadata to extract the identifier
3. Attaches PDF links to matching nodes

This is the recommended approach for industrial documentation systems where hundreds of datasheets, BOMs, and drawings need to be linked to 3D components.

## Private Project Assets

Private projects can store documents in their project folder. The Vite dev server automatically serves files from:

```
realvirtual-WebViewer-Private~/projects/<project>/
```

under the URL path:

```
/private-assets/<project>/<path>
```

### Project Folder Structure

```
projects/myproject/
├── models/MyModel.glb           # 3D model
├── docs/                        # Document library (PDF, any depth)
│   ├── Module_A/
│   │   ├── assembly-drawing.pdf
│   │   └── Subpart_1/
│   │       └── datasheet.pdf
│   └── Module_B/
│       └── bom.pdf
├── aasx/                        # AASX packages (optional)
│   └── component.aasx
├── docs-index.json              # Generated index (article → PDF paths)
├── scripts/
│   └── build-docs-index.mjs     # Index generation script
├── plugins/
│   ├── index.ts                 # Plugin registration
│   └── docs-link-plugin.ts      # Document linking plugin
└── project.json                 # Project metadata
```

### Assets Base Path

When using project-specific AASX files, set `assetsBasePath` in the model config:

```json
{
  "pluginConfig": {
    "aas-link": {
      "assetsBasePath": "/private-assets/myproject/"
    }
  }
}
```

This tells the AASX parser to load `index.json` and AASX files from the project folder instead of `public/aasx/`.

## Building a Document Index

The document index is a JSON file mapping identifiers to arrays of document entries:

```json
{
  "4112630": [
    { "title": "BOM", "path": "docs/Module_A/4112630_BOM.pdf" },
    { "title": "Assembly Drawing", "path": "docs/Module_A/4112630_Drawing.pdf" }
  ]
}
```

### Index Generation Script

This script is not shipped with realvirtual WEB — create it in your own project's `scripts/` folder. The example below scans the `docs/` folder and writes `docs-index.json`:

```javascript
import { readdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', 'docs');

async function scanPdfs(dir, basePath = '') {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await scanPdfs(join(dir, entry.name), relPath));
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      results.push({ relativePath: relPath, filename: entry.name });
    }
  }
  return results;
}

// Extract identifier from filename (customize per project)
function extractId(filename) {
  const match = filename.match(/^(\d+)_/);
  return match ? match[1] : null;
}

const pdfs = await scanPdfs(DOCS_DIR);
const index = {};
for (const { relativePath, filename } of pdfs) {
  const id = extractId(filename);
  if (!id) continue;
  if (!index[id]) index[id] = [];
  index[id].push({
    title: filename.replace(/^(\d+)_/, '').replace(/\.pdf$/i, '').replace(/_/g, ' '),
    path: `docs/${relativePath}`,
  });
}
await writeFile(join(__dirname, '..', 'docs-index.json'), JSON.stringify(index, null, 2));
```

Save it as `scripts/build-docs-index.mjs` in your project and run it whenever your docs folder changes:
```bash
node scripts/build-docs-index.mjs
```

## Writing a Document Link Plugin

A document link plugin loads the index and attaches PDF links to matching nodes:

```typescript
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { PdfLink } from '../core/hmi/pdf-viewer-store';

// Extract identifier from RuntimeMetadata content
const VALUE_TAG_RE = /<value\s+label=["']([^"']*)["']>([^<]*)<\/value>/gi;
function extractField(content: string, fieldName: string): string | null {
  VALUE_TAG_RE.lastIndex = 0;
  let match;
  while ((match = VALUE_TAG_RE.exec(content)) !== null) {
    if (match[1].toLowerCase() === fieldName.toLowerCase()) return match[2].trim();
  }
  return null;
}

export class DocsLinkPlugin implements RVViewerPlugin {
  readonly id = 'docs-link';

  constructor(private basePath: string) {}

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    // Index loading is async; start it fire-and-forget with error handling
    void this.attachLinks(viewer).catch(err => console.error('[docs-link]', err));
  }

  private async attachLinks(viewer: RVViewer): Promise<void> {
    // Load the generated index
    const resp = await fetch(`${this.basePath}docs-index.json`);
    if (!resp.ok) return;
    const index = await resp.json();

    // Traverse nodes with metadata and match identifiers
    viewer.scene.traverse(node => {
      const meta = node.userData?._rvMetadata as { content: string } | undefined;
      if (!meta?.content) return;

      const articleNr = extractField(meta.content, 'Article');
      if (!articleNr || !index[articleNr]) return;

      // Attach PDF links
      if (!node.userData._rvPdfLinks) node.userData._rvPdfLinks = [];
      for (const doc of index[articleNr]) {
        (node.userData._rvPdfLinks as PdfLink[]).push({
          title: doc.title,
          source: { type: 'url', url: `${this.basePath}${doc.path}` },
        });
      }
    });
  }

  dispose(): void {}
}
```

Bind the document to a project module through `documents[].scriptRef`. A direct
`plugins/docs-link-plugin.ts` can export both registration functions:

```typescript
// Add to the module that defines DocsLinkPlugin; RVViewer is a type-only import.
export function registerModelPlugins(viewer: RVViewer): void {
  viewer.use(new DocsLinkPlugin('/my-project-assets/'));
}
export function unregisterModelPlugins(viewer: RVViewer): void {
  viewer.removePlugin('docs-link'); // Must match DocsLinkPlugin.id.
}
```

Host `docs-index.json` and PDFs under the base URL you pass; a folder-project Blob
module has no HTTP directory of its own. `/private-assets/` is a maintainer dev-server
route, not available to a standalone Community project. The
[public project example](doc-project-plugin-example.md) covers compilation and binding.
For production, use a same-origin static directory or a CORS-enabled host you control.

## PDF Viewer

The built-in PDF viewer overlay (`DocViewerOverlay`) automatically renders when a PDF link is clicked. It supports:
- Page navigation
- Zoom controls
- In-document search — the toolbar search box highlights all matches on the page and jumps between matches across pages (`Enter` / `Shift+Enter` for next / previous). The per-page text index is built lazily on first search and cached for the open document.
- Open in new tab
- Loading from URLs or blob extraction from AASX ZIPs

No additional configuration needed — any node with `_rvPdfLinks` in its userData will show PDF buttons in the tooltip.

## Manuals next to the model: `<link url>` into the project (2026-10-12)

A `docs/` tree with `docs-index.json` links documents by part number. The simpler case of a
3D-HMI — "this station, this operating manual" — needs no index and no plugin: the
`RuntimeMetadata` of the station carries a `<link url="…">` whose URL is a **path relative to
the project root**, e.g.

```xml
<link url="Kroenert Files/Final Documentation CD/01-Operation/260_MK_38780_FSU_BAL_ENU.pdf">Open operating manual</link>
```

The tooltip resolves the link once when it renders (`metadata-link-resolver.ts`): if the OPEN
project holds that file, the project backend hands out an object URL for it and a PDF opens
in the built-in viewer (a non-PDF in a new tab) — a folder project reads it straight from
the linked folder, a hosted deploy from the published project. Absolute `http(s)` URLs stay
web links, and a relative URL the project does not hold keeps its legacy meaning as a link
into `https://doc.realvirtual.io/` (Unity demo content). The click is synchronous, so popup
blockers never interfere. Nothing is uploaded anywhere: the manual stays where the project
keeps it.

## Production Deployment

For production builds, host the document index and files at the configured base URL:

1. **Static host**: Copy the `docs/` folder and `docs-index.json` to your HTTP(S) host
2. **Update basePath**: Point to the CDN URL instead of `/private-assets/`
3. The `docs-index.json` is small (< 100KB typically) and can be bundled
4. PDFs are fetched on demand — only opened documents are downloaded

## `_rvPdfLinks` Data Format

Any system can attach PDF links to nodes by writing to `node.userData._rvPdfLinks`:

```typescript
interface PdfLink {
  title: string;
  source:
    | { type: 'url'; url: string }                              // Direct URL
    | { type: 'blob'; aasId: string; zipPath: string;           // Extract from AASX ZIP
        basePath?: string };
}
```

The tooltip system renders all entries automatically.
