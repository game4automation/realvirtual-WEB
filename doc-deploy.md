# Building & Deploying

> **Applies to:** Community self-hosting first; later sections describe maintainer operations that require private tools and credentials.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

*Guide for building realvirtual WEB locally for testing, publishing it with realvirtual's own pipeline, and self-hosting it on your own infrastructure.*

> **The important distinction:** *building* produces a `dist/` folder on your machine and publishes nothing. *Deploying* builds **and** uploads that build somewhere. The built-in `npm run deploy` is **realvirtual's own** publish pipeline — it targets realvirtual's Bunny CDN account and goes live at `web.realvirtual.io`. If you are not realvirtual, you do not have those credentials; see [Deploy it yourself](#7-deploy-it-yourself).

---

## 1. Local build (testing only — nothing is published)

Use these while developing or to verify a production build before it goes out. They never touch any CDN.

| Command | What it does | Where it runs |
|---------|--------------|---------------|
| `npm run dev` | Dev server with hot-module reload | `localhost:5173` |
| `npm run build` | Production build into `dist/` | your machine only |
| `npm run preview` | Serves the built `dist/` as it will look in production | `localhost:4173` |

```bash
npm run dev                  # iterate with HMR
npm run build                # produce dist/ locally
npm run preview              # check the production build before deploying
```

`npm run build` runs `vite build`, writes `dist/`, and stops. The output stays on disk — share it, inspect it, host it yourself (see Deploy it yourself), or run `npm run preview` against it. Nothing is uploaded.

### Build tiers & feature gating (`RV_INTERNAL`)

Every build belongs to one of three tiers, controlled by two switches:

| Tier | How it is selected | What is in the bundle |
|------|--------------------|-----------------------|
| **Public** | Private folder absent, or `VITE_PUBLIC_BUILD=1` | Public (AGPL) code only — `@rv-private` resolves to the no-op stubs |
| **Private / customer** | Private folder present, `RV_INTERNAL` unset | Public code + the **customer tier** of `private-plugins.ts`. This is what `npm run deploy:private` and the Unity Publish tab produce for customer deployments |
| **Private / internal** | Private folder present **and** `RV_INTERNAL=1` (the dev server and vitest always behave as internal) | Everything, including the **internal tier** (`internal-plugins.ts`): features still under development that must not reach customers |

The switch is the `__RV_INTERNAL__` compile-time constant (defined in `vite.config.ts`, analogous to `__RV_COMMERCIAL__`). Internal-tier features are loaded exclusively through a gated **dynamic import**:

```ts
// private-plugins.ts (private folder)
export async function registerPrivatePlugins(viewer: RVViewer): Promise<void> {
  // customer-tier registrations go here — they ship in customer deploys

  if (__RV_INTERNAL__) {
    const { registerInternalPlugins } = await import('./internal-plugins');
    registerInternalPlugins(viewer);
  }
}
```

When the flag is `false`, Rollup eliminates the dead branch **and every chunk behind it** — the internal features (including their workers and WASM payloads) are physically absent from `dist/`, not just hidden. Two rules keep that guarantee intact:

- **Never import internal feature modules statically.** They register components as module side effects, so a static import keeps them in the bundle even inside a dead branch. The node-mode test `tests/private-internal-gate.node.test.ts` guards this boundary.
- **Promote features deliberately.** When a feature becomes customer-ready, move its registration from `internal-plugins.ts` into the customer tier of `registerPrivatePlugins()`.

```bash
npm run dev                    # internal features always available (dev server)
npm run build                  # customer-tier build — internal features excluded
RV_INTERNAL=1 npm run build    # internal build — everything included
```

The same pattern is reusable if you develop on top of realvirtual WEB yourself: gate your own work-in-progress plugins behind `__RV_INTERNAL__` (or your own `define` flag) so your production deployments only ship what you intend to release. The AGPL/commercial licensing terms in section 7 apply to your extensions as usual.

### Feature chunks and on-demand features (plan-652)

Since plan-652 a generated `private-plugins.ts` (customer workspaces, demo build) no longer imports
feature adapters statically. It starts every entitled adapter import in parallel up front
(`const adapterN = early(import('…'))`) and registers them in manifest order with
`await useFeature(viewer, '<id>', () => adapterN)` — the same download as the old single entry, but
each adapter is its own chunk. Registrations whose `activation` (in `tier-manifest.json`) is not just
`startup` — today `asset-editor` (`mode:editor`) and `des` (`mode:des`, `command:sim.discrete`, the DES
component types) — register only a stub at startup; their body chunks load on first use.

What this means for a deploy:

- Every production build writes **`dist/feature-chunks.json`** (files and bytes per feature, from the
  Rollup bundle — no `.vite/` folder lands in `dist/`). The viewer reads it for its diagnostics and
  for the idle prefetch; it is part of the deploy like `features.json`.
- A deploy that deletes the previous version's chunks breaks an open tab's first switch into the
  Editor or DES. The viewer reports *"New version available — reload"* instead of failing silently;
  keeping old assets for a grace period is a separate cache plan.
- **Commit order across the two repositories is public first, private second.** The public core
  tolerates an older private side, and a private stub that meets a core without the FeatureLoader
  loads its body eagerly (logged once) — so a skew in either direction degrades to the old eager
  behaviour instead of breaking the build.
- Before a merge that touches imports of private features, run `npm run test:bundle-guard` (see
  [doc-web-debugging.md](doc-web-debugging.md#on-demand-features-feature-and-the-bundle-guard)).

---

<a id="7-deploy-it-yourself"></a>

## Deploy it yourself

realvirtual WEB is the open standard for browser-based 3D HMI in manufacturing. You can run your own deployment two ways: reuse the built-in tool with your own Bunny account, or treat the build as plain static files and host them anywhere.

> **AGPL obligations apply when you deliver to others.** realvirtual WEB is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. Running it yourself triggers nothing. If you deploy it so that other people use it — a hosted link, a delivery package, an offline installation — everyone who receives it must be able to get the complete source of the delivered software under AGPL-3.0: realvirtual with your changes, tightly coupled plugins and HMI components, and embedded scripts that take over core code. Your model data (geometry, layout, parameters, GLB metadata) stays yours and need not be disclosed. You need not publish to the world, but recipients may pass the AGPL parts on.

> The "Powered by realvirtual WEB · AGPL-3.0" attribution notice stays reasonably visible and legible in every AGPL deployment (additional term under AGPL §7(b), see `NOTICE.md`); position, size and style may be adapted. Removing it or replacing it with your own brand requires a commercial license.

> **Which builds carry the watermark (plan-679 Phase 9).** A pure AGPL / community build — built
> without the private tree (this repository on its own, or `VITE_PUBLIC_BUILD=1`) — always shows it,
> and it cannot be switched off without changing code. Every build that compiles the commercial
> private tree — the public demo, commercial customer workspaces (dev server and build) and hosted
> customer deploys — is built without it: `scripts/lib/rv-agpl-attribution.mjs` removes the
> watermark, the noscript "Source on GitHub" link and the JSON-LD `license` from `index.html`. The
> switch is the build stage (`__RV_AGPL_ATTRIBUTION__ = !HAS_PRIVATE`), not `RV_COMMERCIAL`, which
> only controls installability. The third-party notices are in every build.

> **Keeping a project private?** To keep your own plugins or changes confidential in a delivery, or to remove the attribution notice, use a [commercial license](https://realvirtual.io/en/company/license). See the [README license section](README.md#license) for the canonical terms.

### Use the built-in tool with your own Bunny account

The deploy tool is account-agnostic by design. Every account-specific value comes from environment variables — nothing is hardcoded that you cannot override. Point it at your own Bunny Storage by setting your own credentials:

```bash
# Required — your own Bunny Storage zone
export BUNNY_STORAGE_KEY=your-storage-zone-password
export BUNNY_STORAGE_ZONE=your-storage-zone-name

# Optional — only needed to purge your CDN cache after upload
export BUNNY_ACCOUNT_KEY=your-account-api-key
export BUNNY_PULL_ZONE_ID=your-pull-zone-id

# Optional — region, sub-path, analytics
export BUNNY_REGION=storage.bunnycdn.com
export BUNNY_REMOTE_PATH=                 # empty = storage-zone root; or e.g. demo
export GA_MEASUREMENT_ID=                 # empty = no analytics

npm run deploy                            # builds + uploads to YOUR zone
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUNNY_STORAGE_KEY` | yes | Your storage-zone password |
| `BUNNY_STORAGE_ZONE` | yes | Your storage-zone name |
| `BUNNY_ACCOUNT_KEY` | for purge | Your account API key |
| `BUNNY_PULL_ZONE_ID` | for purge | Your pull-zone id |
| `BUNNY_REGION` | no | Your region (default `storage.bunnycdn.com`) |
| `BUNNY_REMOTE_PATH` | no | Sub-path prefix (default empty = zone root) |
| `GA_MEASUREMENT_ID` | no | Your own GA4 id, or leave empty |

With those set, every upload, list, delete, and purge targets **your** account. The printed `web.realvirtual.io` lines (private mode and the CI workflow) are cosmetic and do not affect where files land — substitute your own pull-zone hostname. If you serve under a fixed sub-path with absolute asset URLs, add `--base /your-path/`.

> **`--base` on Windows: run it from PowerShell.** Git Bash / MSYS rewrites a standalone `/demo/` argument into a Windows path (`C:/Program Files/Git/demo/`) before Node ever sees it. Baked into `index.html`, that produces a build which uploads and reports success while every asset 404s live. `assertSaneBase()` rejects a mangled base **before** anything is built or uploaded — a valid base is `./` or a simple URL path such as `/demo/`, never one with a drive letter, backslash or spaces. Fix it by running the deploy from PowerShell, or by prefixing the Bash command with `MSYS_NO_PATHCONV=1`.

### Host the static `dist/` anywhere

`npm run build` emits a self-contained static single-page app into `dist/`: `index.html`, hashed JS/CSS under `assets/`, and everything from `public/` (including `models/*.glb`, `settings.json`, and `models.json`). With the default relative base (`./`), the whole `dist/` tree can be served from a domain **root** or **any sub-path** without rebuilding. To "deploy it yourself," copy the contents of `dist/` to a web root and serve them as static files.

```bash
npm run build                # produce dist/
# copy dist/* to your web root, then serve over http(s)
```

| Host | How |
|------|-----|
| **nginx** | Copy `dist/` to the document root; add an SPA fallback and the MIME/cache rules below (see example) |
| **Apache** | Copy `dist/` to the DocumentRoot; add `.htaccess` with a rewrite to `/index.html` and `AddType application/wasm .wasm` / `AddType model/gltf-binary .glb` (needs `AllowOverride All`) |
| **AWS S3 + CloudFront** | `aws s3 sync dist/ s3://bucket --delete`; set `Content-Type` on upload (S3 misguesses `.wasm`/`.glb`); map CloudFront 403/404 → `/index.html` (200) for SPA fallback; add bucket CORS and forward the `Origin` header |
| **Netlify** | Build `npm run build`, publish dir `dist`; add `public/_redirects` (`/*  /index.html  200`) and `public/_headers` for cache/COOP-COEP |
| **Vercel** | Auto-detects Vite (`dist`); add `vercel.json` rewrite `"/(.*)" → "/index.html"` and custom headers |
| **Cloudflare Pages** | `npx wrangler pages deploy dist` or Git integration; `_headers` file for cache/COOP-COEP; watch the per-file size cap for large GLBs |
| **GitHub Pages** | Set Vite `base` to `'/<repo>/'`, publish `dist/`, copy `index.html` to `404.html` for SPA fallback; cannot set HTTP headers (no COOP/COEP, no custom MIME) |
| **Local — `vite preview`** | `npm run preview` serves `dist/` on `localhost:4173` with correct MIME types and SPA fallback already wired — the most faithful local check |
| **Local — `npx serve -s`** | From `dist/`, `npx serve -s` (single-page mode → fallback to `index.html`); use HTTPS for WebXR/secure-context testing |
| **Local — `python -m http.server`** | `cd dist && python -m http.server 8000` — quick smoke test only; no SPA fallback, may misreport `.glb`/`.wasm` MIME |

> `file://` does **not** work — `GLTFLoader` fetch is blocked by CORS (origin `null`) and WebXR/camera APIs are disabled. Always serve over an http(s) server, even locally.

### Server caveats (apply to any host)

| Concern | What to do |
|---------|-----------|
| **MIME types** | Serve `.glb` as `model/gltf-binary`, `.gltf` as `model/gltf+json`, `.wasm` as `application/wasm`. Many servers default to `application/octet-stream`, which downloads the GLB instead of loading it and makes `WebAssembly.instantiateStreaming` fail with *"Incorrect response MIME type"* |
| **SPA fallback** | A hard refresh on a deep link must return `index.html` (HTTP 200), not 404. Use `try_files`/rewrite/`_redirects`/`404.html` per host. A blanket fallback also turns missing assets into HTML 200s — scope it so that `library/**`, `models/**` and `*.glb` / `*.kin.json` / `*.splat` / `*.ksplat` / `*.ply` keep real 404s (on Bunny: **no** global "404 → index.html, rewrite to 200" edge rule; condition it on path/extension). An HTML page served under a GLB url is exactly what the viewer's blob cache used to store as "the asset" |
| **CORS** | If GLBs are served from a different origin than the page, the asset response needs `Access-Control-Allow-Origin` (and `GET, HEAD`). Same-origin serving avoids CORS entirely. On S3, also forward/cache the `Origin` header in CloudFront |
| **Cache-Control** | Hashed files in `assets/` are safe to cache forever: `public, max-age=31536000, immutable`. `index.html` is **not** hashed — set `no-cache` so users do not get stale HTML pointing at deleted chunks |
| **HTTPS / secure context** | WebXR (VR/AR) and camera access require a secure context: HTTPS or `localhost`. Plain `http://` on a real domain disables them. All cloud hosts provide free TLS; for local XR use an HTTPS dev server |
| **COOP/COEP** | Only needed if you use `SharedArrayBuffer` / threaded WASM. Then set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) — but COEP makes cross-origin assets require CORS/CORP. If you do **not** use SharedArrayBuffer, do not add these headers |
| **Large GLB** | Enable gzip/brotli and include `model/gltf-binary`/`model/gltf+json` in the compressible types (many servers compress text only). Mind per-file upload caps (nginx `client_max_body_size`, host limits) |
| **Base path** | Default base is `./` (relative) — serve from root or any sub-path without rebuilding. For absolute-rooted asset URLs under a fixed sub-path, build with `--base /your-path/` (or set Vite `base`) and put the SPA fallback under that sub-path too |

### Hosting a GLB for a shared link (`?glb=`)

A shared link (see doc-webviewer.md § *Shared asset links*) may point at any
host. The viewer runs on **your** origin and fetches the file from **theirs**,
so exactly one thing decides whether it works: **CORS on the GLB response.**
Everything else — MIME type included — the loader does not care about.

Measured with `curl -I` against a foreign `Origin` (2026-08-05):

| Host | `Access-Control-Allow-Origin` | Verdict |
|---|---|---|
| `raw.githubusercontent.com` | `*` | works. Serves `application/octet-stream`, which is irrelevant to `GLTFLoader` |
| Bunny pull zone (`web.realvirtual.io`) | `*` | works; also allows/exposes `Range` |
| Firebase Storage (`…?alt=media`) | yes | works — it is what the viewer's own demo GLB is served from |
| A default nginx/Apache/IIS on your own domain | **usually absent** | **the common failure**: an empty viewport |

For your own server, the whole fix is one header on the file:

```nginx
location ~* \.glb$ {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, HEAD" always;
    types { model/gltf-binary glb; }
}
```

A missing header surfaces as a named error in the info card ("… did not allow
this page to read the file (CORS)") rather than as a blank screen, so the
support question answers itself. Note the browser cannot tell a CORS refusal
from an unreachable host — the message names the likely cause and the host,
and stops there.

Two more things worth knowing before publishing a link:

- **Size.** The fetch enforces a 250 MB budget on the *streamed body*.
  `Content-Length` is only a hint (absent under chunked transfer, wrong behind
  a rewriting proxy), so an oversize file is cut mid-transfer, not waved through.
- **Redirects are fine**, and they do not widen the budget: the count runs
  downstream of every hop.

Links that we host (`?glb=s:<id>`) need none of this — they are resolved to a
short-lived signed URL at runtime. That path needs the share backend; its HTTP
contract is `src/core/share/rv-share-backend-contract.md`.

### nginx example

```nginx
# /etc/nginx/mime.types — add these so GLB/WASM load correctly:
#   model/gltf-binary  glb;
#   model/gltf+json    gltf;
#   application/wasm   wasm;

server {
    listen 443 ssl http2;
    server_name viewer.example.com;
    root /var/www/app;          # contents of dist/ copied here
    index index.html;

    # Compress GLB/WASM (text types are compressed by default)
    gzip on;
    gzip_types text/css application/javascript application/json
               application/wasm model/gltf-binary model/gltf+json;

    # SPA history fallback — deep links resolve to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Hashed assets: cache forever
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Entry point: never cache stale HTML
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
}
```

---

## Terms consent gate (plan-2209)

A blocking terms dialog runs before the viewer boots. The build-time constant `__RV_TERMS_GATE__` (`vite.config.ts`, resolved by `termsGateMode()` in `scripts/lib/rv-agpl-attribution.mjs`) selects one of three modes:

| Mode | When |
|---|---|
| `demo` | Production build with `RV_DEMO_NOTICE=1` and path `demo`, without `VITE_PRIVATE_BUILD` |
| `developer` | Dev server in a commercial customer workspace (detected by `delivery-manifest.json`) |
| `off` | Everything else: community and customer builds, vitest |

- **Language:** English only; both modes link to https://realvirtual.io/en/terms/#part-b.
- **Versions:** `DEMO_TERMS_VERSION` and `DEVELOPER_TERMS_VERSION` (`src/core/hmi/terms-consent-store.ts`). Bumping one re-asks every visitor for that mode; the two modes are acknowledged independently.
- **Storage:** localStorage key `rv-terms-consent`. If storage is blocked, the acknowledgement lasts for the session only.
- **Automation:** with `navigator.webdriver === true` (Playwright, recording scripts, smoke tests) the gate is skipped and nothing is stored. Do not seed the key in scripts.
- **Order:** terms gate, then analytics gate.
- **Bundle check:** `rv-terms-gate-root` must be absent from community and customer builds. The demo chunk is about 3.5 kB gzip.

---

## Maintainer operations

The remaining deployment procedures use realvirtual infrastructure or private tools.
Community self-hosters do not need these steps.

## 2. realvirtual's deploy pipeline (publishes to web.realvirtual.io)

> **This is realvirtual's own pipeline.** `npm run deploy` builds the app and uploads it to **realvirtual's** Bunny CDN account, where it goes live at `web.realvirtual.io`. It only writes to that account when `BUNNY_STORAGE_KEY` (realvirtual's secret storage-zone password) is provided. A third party does **not** have that key — a bare `npm run deploy` with no environment configured fails fast with `Missing required env BUNNY_STORAGE_KEY` before anything is uploaded. To publish your own build, point the tool at your own account or host the static files yourself — see [Deploy it yourself](#7-deploy-it-yourself).

`npm run deploy` maps to `node scripts/bunny-deploy.mjs`. It **builds** the app (public build, `VITE_PUBLIC_BUILD=1`) and then **uploads** the result to Bunny CDN.

```bash
npm run deploy -- --path demo        # upload under a specific remote path prefix
npm run deploy -- --root             # deliberate deploy at the zone root (refused without the flag)
npm run deploy -- --dry-run          # stage only; build and upload nothing
npm run deploy -- --demo --path demo --base /demo/   # hosted demo of the COMMERCIAL product
```

`--demo` is the same public deploy with a different **code tier**: instead of the core-only AGPL build it compiles the full commercial feature set (every commercial registration of the tier manifest a customer receives — asset editor, CAD importers, PLC, physics, machining, IK, …; `FEATURES.md` lists the current set) into the very same public demo site. Everything else is identical: same remote prefix, same model allowlist, same test-scene prune, same GA/news/SEO injection, same signing.

What the demo form does **not** do: it never sets `RV_INTERNAL` (agents and Omniverse are restricted features and stay out), it never emits source maps, and it stages no customer project. The private TypeScript ships as compiled chunks only — a `.map` next to a commercial chunk would be the source code itself, so the deploy refuses to upload any `.map`, `.ts` or `.tsx` found in the build output.

The remote path comes from `BUNNY_REMOTE_PATH` (default empty = storage-zone root, printed as `(root)/`) and can be overridden per run with `--path`.

> **A deploy never uploads the repository's own `dist/`.** It builds from a **temporary, filtered staging workspace** and uploads *that* build. `--no-build` no longer exists: passing it aborts immediately with *"--no-build is disabled: deploys must build from filtered staging."*

What happens, in order:

1. **Stage** — `stageFilteredSourceTree()` (`scripts/_workspace-lib.mjs`) copies an allowlisted source tree into a fresh temp directory (`rv-customer-workspace-*` under the system temp folder). Only the public demo profile (core tier, no project) carries the demo documents and `public/aasx/` along; see [What the public demo ships extra](#current-project-layout-by-delivery-channel). The staging directory is removed on every exit path — also when staging, the build or the upload fails. Set `RV_KEEP_STAGING=1` to keep it for inspection; the log then names the path.
2. **Build in the staging workspace** — `npm ci` **inside that temp workspace**, then `npm run build` with `VITE_PUBLIC_BUILD=1`. The fresh `npm ci` installs into an empty `node_modules` and routinely runs for **several minutes with no output** — that silence is the install, not a hang. Deploys to `--path dev` and `--path demo-beta` skip it when they can: they reuse a machine-local `node_modules` cache keyed by the lockfiles **and** the Node major/ABI, platform and architecture, and log `build-cache: hit` (or `rebuild` on the first run after a change). `/demo`, `--root` and private deploys always install fresh. Parallel local builds share that cache safely: a build holds a reader lease on its cache profile until it ends, and a profile is only deleted — on a failed restore, or when it has been unused for 30 days — while nobody reads it. The build output is stamped with `.rv-build-provenance.json` (source-tree hash, mode, project) and re-checked by `assertBuildProvenance()` before a single byte is uploaded. Your working `dist/` is neither read nor written.
3. **Model allowlist** — the demo manifest in `demo-realvirtual/project.json` declares its documents; the app-level component library stays under `library/`. The deploy applies its manifest-based pruning and verifies that referenced GLBs remain present. Legacy root-manifest/prefix behavior is compatibility handling, not the current directory layout. See [Public model allowlist](#public-model-allowlist).
4. **Dev-only prune** — documents the manifest marks `devOnly: true` are dropped from `dist/`, file and manifest row alike. See [Public dev-only prune](#public-dev-only-prune).
5. **Sign + stamp + inject** — GLBs are signed when `RV_SIGN_PRIVATE_KEY` is configured (see [GLB signing](#glb-signing-and-password-protection)); **then** every `catalog.json` in the build output — and the rows of the realvirtual library's `library/project.json` (plan-778) — is re-stamped with the `sha256` + `sizeBytes` of the bytes that now ship (`stampCatalogHashes`, see [Library catalog hashes](#library-catalog-hashes-and-the-post-deploy-probe-plan-508)); then the GA id, the news feed URL and the SEO tags are written into the built artifact only.
6. **Diff** — the deploy first takes the **publish lock** of its target (`rv-publish-<zone>:<prefix>`, a Windows named pipe) and holds it until after the probe and the demo smoke (steps 9 and 10); a second local deploy to the same target waits with `waiting for publish lock …` (see [Automatic /dev deploys](#automatic-dev-deploys)). Inside the lock it reads the **currently published** `catalog.json` files and library `project.json` manifests (`library/project.json`, a hosted `p/libraries/<id>/project.json`) and selects every catalogued file (`glbUrl` / `splatUrl`, or a document row's `path`) whose hash changed — regardless of size (nothing published yet: all of them). Then the remote file list is fetched; unchanged files (same size) are skipped. `*.html`, `settings.json`, `models.json`, `manifest.json`, `project.json` and every `catalog.json` are always re-uploaded, and so is every GLB once signing is active (re-signing is size-preserving, so a size diff would skip it). `*.map` files are never uploaded.
7. **Upload** — changed files are uploaded in parallel (`RV_DEPLOY_CONCURRENCY`, default 8, and at most `RV_DEPLOY_MAX_INFLIGHT_BYTES`, default 64 MB, of file data in flight — a larger file uploads alone). Every `catalog.json` and every library `project.json` waits until **all** other asset uploads have finished and goes next — so a failed binary leaves the OLD catalog remote and the next run's hash diff selects the binary again. Every `*.html` file follows after that, one by one, `index.html` last, so the live site never points at missing assets mid-deploy. If an asset upload still fails after its retries, the deploy stops there: no HTML, no deletions. Remote files that no longer exist locally are then deleted (also in parallel, at most 8); a delete Bunny refuses is counted and reported but never stops the deploy or the purge. Storage requests retry up to three times with backoff and honour `Retry-After`. The remote listing retries too and **fails the deploy** on an auth, network or server error instead of continuing half-blind — only a missing prefix (404, the first deploy to a new path) counts as empty.
8. **Purge** — the CDN cache is purged once (only if something was uploaded, and only when the account/pull-zone purge credentials are present).
9. **Probe** — still inside the lock, the live host is asked three things (`probePublishedAssets`): a missing asset answers 404 (Bunny's HTML error page is accepted, a 200 is not), `library/project.json` is byte-equal to the build output, and the first listed asset hashes to its row's `sha256`. Any finding fails the deploy with exit 1 and a plain-text cause; `--skip-probe` skips it (offline runs). A failed probe stops the deploy before the demo smoke.
10. **Demo smoke** (plan-503) — still inside the publish lock and after the probe, the deploy opens every `demos` document of the demo manifest on the **live** target with Playwright and runs two visitor journeys. The build is already live at this point; the smoke only reports. Details below.

#### The demo smoke after every public deploy

Every public deploy (`--path dev`, `--path demo`, `--path demo-beta`, `--root`; also the `/dev` watcher) ends with `scripts/rv-demo-smoke.mjs` against `RV_PUBLIC_BASE_URL` (default `https://web.realvirtual.io`) plus the remote prefix — e.g. `https://web.realvirtual.io/dev/`. `--dry-run` and `--private` never run it; `--no-smoke` skips it (log: `smoke : skipped (--no-smoke)`).

1. The deploy writes `expected.json` = `{ pair, baseUrl, demos, fingerprint }` from the **staging** `dist/` it just uploaded (after SEO injection and pruning): sha256 of `index.html` and of `demo-realvirtual/project.json`, and the byte size of every `demos` GLB. A local rebuild is never byte-identical to a deploy, so nothing else is ever used as the expectation.
2. The runner checks the runtime (`node_modules/playwright/cli.js` and a `chromium*` folder under `PLAYWRIGHT_BROWSERS_PATH`), the reachability of the demo manifest, and polls up to 60 s (every 2 s, `Cache-Control: no-cache`) until the CDN serves exactly those bytes — GLB sizes by `HEAD` with `Accept-Encoding: identity`, because Bunny sends no `Content-Length` for a gzip response and never an `ETag` for a GLB.
3. It runs `playwright test --project=prod-demo` directly through the CLI (no `npm run e2e`, no test lock), 1 worker, 1 retry, 120 s per test (180 s for the planner journey, which boots the demo twice), 10 min in total:
   - `demo-smoke.spec.ts` — every `demos` document boots: model loaded, no page/console error, no Problems panel, no 404 other than the root `project.json`/`models.json` probes and optional `*.kin.json` sidecars;
   - `hmi-journey.spec.ts` — the HMI demo runs **by itself** (pixel diff of the moving machine, threshold calibrated by `e2e/prod-demo-calibration/`), the bottom bar and the hierarchy panel work;
   - `planner-journey.spec.ts` — `ChainConveyor_1m` is dragged with the real mouse, moves > 0.1 m, nothing else moves, and after a reload it is back at its start position (the `?doc=` demo is read-only — contract `transient`).

   The specs only **read** `window.viewer`; they click no 3D buttons and set no signals. Analytics requests are aborted and the consent gate is accepted, so a smoke run never counts as a visitor.
4. The runner always writes `smoke-result.json` (status `ok | failed | skipped`, `reason`, `failures[]` with attachment paths, `flaky[]`, per-step timings); the raw Playwright report sits next to it as `playwright-report.json`, screenshots and traces under `artifacts/`. A test that is missing, skipped or filtered counts as `incomplete` — green only when all expected tests ran.

**Where the output goes:** `RV_SMOKE_OUT_DIR` when set (the watcher: `<root>\last-smoke\`), otherwise `<repo>/.smoke/<ISO time>/` (gitignored) — never inside the staging tree, which the deploy deletes. The log ends with `SMOKE_STATUS=<status>` and `SMOKE_REPORT=<path>`.

**Failure reasons** (`reason` in `smoke-result.json`): `runtime-missing`, `unreachable`, `stale-cdn` (the CDN did not serve the uploaded bytes within 60 s — a finding, not noise), `expected-unreadable`, `timeout` (the `line` reporter output is kept as `partialLog`), `crashed`, `report-unreadable`, `incomplete`, `tests`. There is no silent skip: only `--no-smoke` skips.

**Exit codes of `bunny-deploy.mjs`:**

| Exit | Meaning | What to do |
|------|---------|------------|
| `0` | Deploy OK; demo smoke OK or skipped (`--no-smoke`, `--dry-run`, `--private`) | nothing |
| `3` | Deploy OK — **the build is live** — but the demo smoke FAILED | read `smoke-result.json`; roll back by re-deploying the previous tag (there is no automatic rollback) |
| `1` | Deploy failed (build, guard, upload, lock, post-deploy probe …) | as before |

**Running the smoke by hand** needs a recorded stand — `npm run smoke:prod` refuses to start without one:

```powershell
npm run smoke:prod -- --expected <root>\last-smoke\expected.json                      # the watcher's last /dev deploy
npm run smoke:prod -- --expected .smoke\<time>\expected.json --out .smoke\manual      # a release deploy's stand
```

`--dist <dir>` exists only for the deploy path (the uploaded staging `dist/`); there is no default `dist/` and no "live confirms itself" mode. Reading a red result: see `doc-web-debugging.md` § *A demo is red on /dev/*.

### Library catalog hashes and the post-deploy probe (plan-508)

Every document row of a library `project.json` (since plan-778 the realvirtual library's own manifest, `public/library/project.json`) and every entry of an external `catalog.json` may carry these optional fields next to its `path` (`glbUrl` / `splatUrl` in a catalog):

| Field | Meaning |
|---|---|
| `sha256` | SHA-256 of the file behind `glbUrl` / `splatUrl` — hex, lowercase, 64 characters. The viewer's blob cache keys on it and verifies every download against it. It is **never** a resolution key: a reference resolves by id/path exactly as before. |
| `sizeBytes` | Size of that file in bytes (diagnostics; the probe falls back to it for an entry without a hash). |
| `thumbnail` | The saved preview of the entry (plan-776), relative to the catalog: `<Category>/.thumbnails/<id>.<hash8>.<webp\|png>`. `build-local-library-catalog.mjs` (which writes `public/library/project.json`, no `catalog.json` any more) derives it on every build from the category folder (newest hashed file wins); absent = the library card shows its placeholder. Library thumbnails live **per category** because a customer delivery copies whole category folders. |

Who writes them: `scripts/build-local-library-catalog.mjs` (runs in `prebuild` — the unsigned dev bytes, correct for `vite dev`), `scripts/build-library-catalog.mjs` (the GitHub library; downloads each GLB once to hash it), and the deploy's `stampCatalogHashes` **after** signing — signing changes every GLB at the same size, and a hash stamped before it would make every signed library GLB a "hash mismatch" in every browser. A catalog without the fields stays valid: the viewer then keeps its url-keyed, revalidating cache path. The private deploy stamps its staging tree too (after signing and, when password-protected, encryption — the hash describes the bytes the browser downloads).

The post-deploy probe (public deploys) asks the live host, with a cache-busting `rv-probe` query on the catalog and asset requests:

1. `GET <base>library/__rv-probe-missing__.glb` must answer **404** — any content type; Bunny's standard `text/html` error page is accepted (observed 2026-09-27), since the status is what keeps a missing asset out of the viewer's cache. A 200 (any type) means a global SPA fallback / "rewrite 404 to 200" rule is catching asset paths — fix the pull zone's edge rules; any other status fails too. The path is reserved: a build output that contains it is refused.
2. `GET <base>library/project.json` must answer 200 with JSON **byte-equal** to `dist/library/project.json` (rows in `documents[]`; an external catalog can still be probed through `catalogRel`) — catches a size-skipped upload or a stale edge copy (e.g. purge credentials missing).
3. The first listed asset must answer 200 as `model/gltf-binary` or `application/octet-stream`, and its bytes must hash to its row's `sha256` — catches a size-preserving re-sign that was not stamped.

Private (`--private`) deploys are stamped but not probed.

> **Tip:** `--dry-run` means different things in the two modes, and the public one is deliberately cheap. A **public** dry run stages the filtered source tree, prints the single line `[dry-run] filtered public source staged; no build/upload performed`, deletes the staging directory and returns — it does **not** build, and it prints **no** allowlist report, no zone and no file list. A **private** dry run does print mode, zone and remote prefix (plus the encryption/signing lines) before it stops short of staging and uploading.

### Third-party licence notices (plan-544)

Every build writes two files into the root of `dist/` (and `dist-embed/`): `THIRD-PARTY-NOTICES.txt`
— name, version, licence, copyright, notes and the deduplicated licence texts of every third-party
component that is actually shipped — and `third-party-notices.json` (the same inventory plus the
`mode`, for scripts). The settings footer links the text file ("Open-source licenses"), relative to the
deploy base. Both are plain dist-root files: every channel — Bunny public/demo/private, the hosted and
password-protected deploys (never encrypted), the embed release (`embed-deploy.mjs` refuses to publish
without them), customer workspaces (built by the customer) and the CONNECT `webui.zip` — carries them.

**Where the list comes from.** `scripts/vite-plugin-third-party-notices.mjs` records the modules of every
emitted chunk and asset — main build **and** every worker pass (it is registered in `plugins` and
`worker.plugins` of `vite.config.ts` and `vite.embed.config.ts` with one shared collector) — maps each
module to its npm package (`node_modules`, nearest named `package.json`), adds the hand-maintained
`third-party/manual-components.json` entries whose `match` globs hit a module, an asset or a `public/`
file (Draco decoder, three.js-vendored libs, the PDF.js worker, the HDRI, demo FMU, …), and applies the
licence policy. The shared core is `scripts/lib/rv-third-party-notices.mjs` (also used by CONNECT).
`npm run dev` answers `/THIRD-PARTY-NOTICES.txt` with a *development preview* from the lockfile.

**occt-import-js (LGPL-2.1-only) is a loose file, never bundled.** When the STEP-import worker is part of
the build, `occtLooseFilePlugin` (vite.config.ts) copies `node_modules/occt-import-js/dist/occt-import-js.js`
and `.wasm` byte-for-byte to `dist/occt/`; the worker loads them at runtime from `<base>occt/` (dev: served
from node_modules). Those files carry our memory limit patch (`scripts/patch-occt-memory.mjs`, 2 GB → 4 GB
heap ceiling), so the manual-list entry declares `"modified": "memory limit patch"` and the notices say so
next to the name. A customer may replace both files with an interface-compatible build.

**Policy.** `third-party/license-policy.json` (public, mirrored — never a private package or vendor name):
`allowed` SPDX ids, `dynamicOnly` (LGPL — allowed only as a separate, replaceable library, never bundled
into a JS chunk), `exceptions` and `vendorTerms`, each with `reason`, `decidedBy`, `date`. Exceptions for
private-tier packages live in `realvirtual-WebViewer-Private~/third-party/license-policy.json`, read only
when the private tree is part of the build. An entry with `decidedBy: "proposed"` is a proposal: it never
silences a violation. Unknown/missing licences or texts, non-allowed licences, bundled LGPL, third-party
GPL/AGPL and **stale** entries are violations. Which policy is stale-checked depends on the build's
notices tier (plan-679 Phase 3): the public policy in every tier; the private policy in the full
private build (`private`: dev and Bunny private builds) and in a **customer workspace build**, which
runs as its delivery tier (`runBuild` sets `RV_NOTICES_TIER=<delivery.tier>`; never inherited, an
unknown value is a hard error). A policy entry may name the tiers that carry it — `"tiers":
["commercial"]`, or `["private"]` for a package only the full build carries (the staging prunes
every `@nvidia/` dependency for every delivery tier). A delivery-tier build checks only the entries
that name its tier (and those without `tiers`); the others are a `not-in-tier` info line. The full
private build checks every entry. `tests/third-party-notices-tiers.node.test.ts` runs the rule
statically in the normal suite: every entry must be declared by the manifest each tier it names
receives. An entry is stale only when it covers nothing the product can ship: an approval for a
component the product *declares* (any manual-list entry, any dependency of the root or the Private
`package.json`) but this build does not ship — the demo AASX files in a customer workspace, an
internal-tier package in a customer build — is not stale (CONNECT: any manual-list entry, e.g. the
Windows-only vendor DLLs in the linux build). The number of exceptions has a shrink-only ceiling (`EXCEPTION_CEILING` in
`tests/third-party-notices.node.test.ts`) — raising it needs Thomas' approval.

**Modes.** `enforce` fails the build on any violation; `warn` builds, puts a *Policy violations* section at
the top of the file and records `"mode": "warn"` in the JSON. `RV_NOTICES_MODE=warn|enforce` always wins.
Without it our own staged builds (`runBuild`: Bunny, delivery, CONNECT staging — they set
`RV_NOTICES_RELEASE_BUILD=1`) and the embed build use the release default, a plain `npm run build`
(local, customer workspace) uses `warn`. **Since plan-544 Phase 6 (2026-10-21) the release default is `enforce`**
(`RELEASE_DEFAULT_MODE` in the core). `bunny-deploy.mjs` and `embed-deploy.mjs` print the mode and a
loud banner when it is `warn` or the notices are missing. `RV_NOTICES_MODE=warn` is the emergency switch;
there is no `off`. CONNECT has its own switch, `-p:ThirdPartyNoticesMode=warn|enforce`
(`doc-connect.md` § *Third-party licence notices*).

**Customer workspaces.** The plugin, the core, the policies (public + Private) and the licence texts are
delivered; the customer's `npm run build` generates the notices in `warn` mode. A customer may add
`realvirtual-web/third-party/license-policy.customer.json` (same format, never stale-checked): we never
ship one and every snapshot keeps the customer's copy.

### Current project layout by delivery channel

| Channel | Manifest and document location |
|---|---|
| Community/dev checkout | `public/demo-realvirtual/project.json` and its relative document files |
| Hosted demo | `dist/demo-realvirtual/` is published as `demo-realvirtual/` |
| CONNECT public demo | The bundled `demo-realvirtual/` project; a projectless CONNECT build may omit it |
| Generated customer workspace | A demo can be seeded as `projects/demo-realvirtual/`; customer projects live under `projects/<key>/` |
| Customer project deployment | The selected project's root manifest and relative assets |
| Projectless generated viewer | A generated `realvirtual-web/public/project.json`, distinct from the source demo |
| Foreign host | Its own readable manifest and documents; no synthetic project is inferred from loose files |

`includePublicDemoContent` controls demo content in a staged hosted build.
Customer staging can copy the demo separately through `copyDemoRealvirtualFolder`;
that is distinct from copying it into the viewer's `public/` folder. The app-level
library remains `public/library/`, independently of the demo project.

The build-time `public/models/*.glb` catalogue scan is gone. A missing/invalid
manifest does not synthesize a project. Check the exact requested URL, CORS and
JSON when a project is unavailable. A directory containing GLBs is not sufficient.

### Public model allowlist

For a maintained public CDN deployment, the demo's own manifest controls its
published model list. Current builds read `dist/demo-realvirtual/project.json`;
a root `dist/project.json` is a compatibility fallback for older build layouts.
`RV_PUBLIC_MODEL_PREFIX` remains an explicit maintainer override, and the legacy
prefix fallback applies when no usable manifest is present. These deploy filters
are not a way to register a new Community project document.

The standard library is app-level, under `library/`, and is not the demo's model
folder. `publicDemoManifestMisses()` verifies the declared GLB files after pruning;
its current implementation in `scripts/_bunny-lib.mjs` is the deploy contract.
A plain local build and the maintained CDN deploy have different staging/pruning
steps. Never infer published content just from loose development files.

### The demo manifest is a deploy artifact

The current source demo manifest is copied to `demo-realvirtual/project.json` on
the host. Manifest responses must revalidate rather than use immutable caching.
The CDN upload logic treats `project.json` specially by basename, including nested
project manifests. Publish all referenced files with the manifest and verify paths
case-sensitively on the host. See [Migration](doc-migration.md) for the old layout.

The demo copy in a generated customer workspace is a separate project folder;
its presence does not make it the customer's own project or make an HTTP backend
writable. See [Projects and saving](doc-projects.md).

### Rolling back the demo

Since plan-726 the demo boots from `project.json` on every channel, so a bad
demo is no longer one deploy shape but four. The cost of undoing it depends
entirely on **which layer** is wrong, and the three layers have nothing in
common: one is a file you can replace in seconds, one is an environment
variable, one needs the whole bundle back.

Work out which row you are in first — the wrong lever is slower than no lever.

| Symptom | Layer | Cost |
|---|---|---|
| Demo opens the wrong document, shows an empty viewport, or lists documents that 404 | Manifest content | **Seconds** |
| A demo model is missing from the site, or a model that should not be public got published | Deploy allowlist | **One redeploy** |
| Boot opens nothing at all, dashboard opens on every visit, CONNECT embed stays gated | Code (Phase 2 / Phase 4) | **Full redeploy of the previous version** |

#### 1. Manifest content — replace the one file

The manifest is the only part of the demo that is *not* immutable, and that is
deliberate. It is in `ALWAYS_UPLOAD_FILES`, so it bypasses the size diff, and
the pull zone is purged after upload; the client fetches it with
`cache: "no-cache"`. A correction therefore lands on the next deploy without
touching the bundle.

```bash
# Fix public/demo-realvirtual/project.json, then:
npm run deploy                       # re-uploads project.json + purges
curl -s https://web.realvirtual.io/demo-realvirtual/project.json | head -20   # verify what is live
```

> **One-off CDN task, still open (plan-737).** The demo GLBs moved from the
> deploy root into `demo-realvirtual/`, and the in-app `?model=` alias only
> covers links opened *through the viewer*. A direct fetch — a `curl`, a
> crawler, an `<img>`/`<script>` style hotlink, anything without JS — still asks
> for the old path and gets a 404. Add a Bunny **Edge Rule** on the pull zone
> (*Action: Redirect to URL*, 301) for the three old root paths
> (`/DemoRealvirtualWeb.glb`, `/DemoPlanner.glb`,
> `/DemoRealvirtualWeb.settings.json`) → `/demo-realvirtual/<same file>`. This
> is a manual step in the Bunny dashboard; nothing in this repository can do it,
> and it has NOT been done yet.

To fall back to **no** curated demo at all, delete `public/demo-realvirtual/project.json` and
deploy: step 7 removes remote files that no longer exist locally, and
`BundledBackend.readManifest()` then returns `null` and says why in the console.
There is **no** synthetic fallback any more — `_syntheticManifest()` went with
plan-735, precisely so that a broken manifest stops being indistinguishable from
a working one. The deploy then has no demo project at all (a named error, not a
white page), and restoring the file reverses it.

> Confirm it is really the manifest before reaching for the bundle. Open the
> browser console: an invalid manifest logs a `[bundled] … is not a valid v2
> project manifest` warning and says it is falling back. No warning means the
> manifest was accepted and the fault is downstream.

#### 2. Deploy allowlist — the env override outranks the manifest

`RV_PUBLIC_MODEL_PREFIX` sits **above** the current `dist/demo-realvirtual/project.json` (or a legacy root `dist/project.json`) in the precedence
list precisely so it stays usable as a rollback lever. Use it when the manifest
is right but the shipped model set is not, or to get a correct site out while
the manifest question is still open.

```bash
RV_PUBLIC_MODEL_PREFIX='DemoRealvirtual,DemoCSGMachining' npm run deploy
```

The prune header names the curator that applied, so the log tells you whether
the override took effect. This is a **stopgap, not a fix** — it re-opens the
`DemoRobotIK` defect the manifest closed, so remove it once the manifest is
correct.

#### 3. A deploy that aborts on the manifest guard is not a rollback case

`publicDemoManifestMisses()` failing means the guard did its job: the manifest
names a document that is not in `dist/`. Nothing was uploaded and the live site
is untouched, so there is nothing to roll back — fix forward. Either add the
missing file to `public/` or remove the row from the manifest, then deploy
again. Check the spelling case-first: the comparison is case-sensitive because
the storage zone is, and a `Models/…` typo passes on Windows and fails here.

#### 4. Code regression — the previous version, in full

There is no feature flag and no kill switch for the boot switch (Phase 2) or the
CONNECT embed gate (Phase 4). The JS bundle is content-hashed and immutable, so
the only way back is to build and deploy the previous commit:

```bash
git log --oneline -- public/demo-realvirtual/project.json src/main.ts   # find the last good commit
git checkout <sha> -- <the files>                      # or: git revert <sha>
npm run typecheck && npm test
npm run deploy
```

This is a **deliberately accepted** cost, recorded in plan-726 §5.6: whoever
ships a boot-behaviour change keeps the previous version ready. Two practical
consequences:

- **Reverting `public/settings.json`'s `defaultModel` alone does not help.** It
  and the manifest start document are one decision now. Putting the value back
  without reverting `main.ts` reintroduces the split that made Phase 2 atomic.
- **CONNECT ships from the sibling checkout, not a published package.** A web
  rollback that touches the embed path needs `Assets/realvirtual-Connect~`
  moved in the same step, or the bundle it stages goes out of sync.

### Public dev-only prune

The same rule applies to example scenes, and since **plan-731** the manifest says which ones. A repo fixture belongs in the dev checkout and must never appear on the public demo, so its `documents[]` row carries `devOnly: true` — and `applyPublicScenePruning` deletes both the FILE and the ROW from `dist/`, wherever in the deploy the file sits.

That replaced a filename convention: anything under `dist/scenes/` starting with `Test`. Two things were wrong with it. It could not say "this is a fixture" about a file whose name does not begin with Test, and it could not be seen from the manifest at all — so no release gate could check that it had done its job. `devOnly` says it once, in the place the app and the gate both read.

The old rule survives as a **fallback** for a `dist/` built from an older source tree, whose manifest carries no `devOnly` anywhere: the prefix pass still deletes `dist/scenes/<prefix>*.glb` and rewrites the curated `dist/scenes/index.json` that such a tree still ships. It matches the pre-plan-413 `.scene.json` spelling too — pruning a file that is not there costs nothing, while dropping the pattern would leak a fixture out of an old `dist/`.

Whether the prune actually worked is no longer taken on trust: `assertManifestResolves()` (`tests/helpers/`) runs over the STAGED output of every channel and refuses a `devOnly` row that survived, a document whose file did not travel, or a start document that resolves to nothing.

The prefix defaults to `Test` and is overridable per deploy with `RV_PUBLIC_TEST_SCENE_PREFIX`. The step is idempotent and public-only; private projects ship the scenes their manifest declares.

### Analytics

The committed `settings.json` ships with an empty Google Analytics id so forks send no traffic into realvirtual's property. The real id is injected into the **deployed** `settings.json` only, from the `GA_MEASUREMENT_ID` environment variable. Leave it unset for no analytics.

**Consent gate.** Google Analytics is a non-essential tracker (it sets cookies and transfers usage data to Google), so it only loads after the visitor opts in. When `analytics.googleAnalyticsId` is set, a blocking consent dialog is shown at startup and the app does not boot — and no GA script is loaded — until the visitor accepts. When no id is configured (every private/self-hosted deploy), there is no gate and nothing is tracked. Consent is persisted and can be withdrawn under **Settings → Backup → Privacy**. Optionally set `analytics.privacyPolicyUrl` in `settings.json` to show a privacy-policy link on the gate. Once granted, realvirtual emits GA4 events that distinguish what the visitor looks at (`model_view`, `workspace_mode`).

### SEO artifacts (public deploy)

The app is a canvas SPA — search engines cannot read the 3D content, so the deploy pipeline maintains a static, crawlable layer around it. The committed `index.html` carries only **deployment-neutral** tags (title, meta description, URL-free Open Graph tags, JSON-LD, a `<noscript>` description); everything URL-bound is injected into the **deployed** artifact only, mirroring the GA `settings.json` injection.

One public path is THE canonical, indexable deploy — by default `demo` (`RV_SEO_CANONICAL_PATH`). What each deploy target gets:

| Deploy | Treatment |
|--------|-----------|
| Public, prefix = canonical path (`--path demo`) | `<link rel="canonical">`, `og:url`, `og:image`, `twitter:card` injected into `index.html`; `sitemap.xml` + `robots.txt` (allow-all + absolute `Sitemap:` line) written into the deploy; the same `robots.txt` additionally uploaded to the **storage-zone root** (crawlers only honor `/robots.txt` at the domain root) |
| Public, other non-root prefix (e.g. `dev`) | `<meta name="robots" content="noindex, nofollow">` injected — CI/dev deploys never compete with the canonical demo in search results |
| Public, zone root (empty prefix — e.g. forks) | untouched, unless `RV_SEO_CANONICAL_PATH` is explicitly set to `""` |
| Private (`{code}/`) | `noindex, nofollow` always injected — unguessable customer URLs must never be indexed (a robots.txt below the domain root has no effect; the meta tag works at any path) |

Configuration (all optional): `RV_PUBLIC_BASE_URL` (absolute origin for canonical/sitemap URLs, default `https://web.realvirtual.io` — forks substitute their own host), `RV_SEO_CANONICAL_PATH` (default `demo`), `RV_SEO=0` (disable everything).

**og:image:** the injection prefers a dedicated `public/og-image.png` (1200×630, card style `summary_large_image`) and falls back to the square PWA icon (`summary` card) when absent. To improve link previews, drop a real marketing screenshot at `public/og-image.png`.

### AI error diagnosis (CONNECT backend)

Delivered variants can arm the AI error diagnosis by setting two URLs in the deployed `settings.json` (see `settings.example.json`):

```json
"diagnostics": {
  "diagnoseUrl": "https://connect.example.local",
  "notesUrl": "https://connect.example.local"
}
```

- `diagnoseUrl` — base URL of the CONNECT diagnosis endpoint (`POST {diagnoseUrl}/diagnose`). When set, `WebDiagnostics` markers trigger real backend diagnoses; when absent, the events are ignored and the offline demo path stays active.
- `notesUrl` — base URL of the CONNECT comment store (`GET/POST {notesUrl}/comments`). When set, operator notes are shared across clients; when absent, notes stay in `localStorage`.

Both values are deploy config without an editing UI (like the analytics id) — `lockSettings` is UI visibility only and NOT the protection mechanism. The CONNECT server must allow the deploy origin via a **narrow CORS `Access-Control-Allow-Origin`** (the bundle host, no wildcard) and should rate-limit `/diagnose`. The browser never holds an LLM key, vector index or PDF full text (BFF pattern).

### Documentation base URL (`docs.baseUrl`)

The help button in the ActivityBar and <kbd>F1</kbd> open the product documentation in a new tab.
A deployment that mirrors or replaces that documentation points the base URL at its own site:

```json
"docs": {
  "baseUrl": "https://docs.customer.example/machine-help/"
}
```

- Default: `https://realvirtual.io/doc/web/`.
- The topic paths below the base stay the same (`planning/layout-planner/`, `connect/overview/`, …),
  so a mirror only needs to keep the page structure.
- A trailing slash is optional — it is added when missing.
- A value that is not an absolute `http:`/`https:` URL is ignored and the default is used. That
  is a hard rule, not a convenience: it keeps a malformed settings file from turning the help
  button into a script-injection vector.
- Deploy config without an editing UI, like the analytics id and the diagnostics URLs.

Whether the entry is offered **at all** is a separate switch — the `help` element under
`ui.visibilityOverrides`, which `main.ts` registers before React mounts:

```json
"ui": {
  "visibilityOverrides": {
    "help": { "shownOnlyIn": ["never"] }
  }
}
```

It defaults to `{ "hiddenIn": ["kiosk"] }`. An override that can never be satisfied (as above)
removes both the button and the <kbd>F1</kbd> route from a delivery — the key sits behind the
same rule as the button, so there is no way to keep one without the other.

---

## 3. Deploy a private project

Private customer projects publish as a **hosted deploy** (plan-759) to an unguessable URL `web.realvirtual.io/{code}/`, isolated from the public demo. The project is a **folder**, and the deploy publishes that folder:

```
{code}/index.html, assets/, settings.json   ← the runtime (dist/, without the public demo's models/, scenes/, library/)
{code}/p/**                                 ← the project folder, byte for byte, minus the deny list
```

```bash
npm run deploy:private -- --list                       # list available private projects
npm run deploy:private -- --project "Customer XY"      # build + publish one project
```

The viewer boots the served project through `settings.json` (`projectUrl: "p/"`) exactly as the appliance does with `?projectUrl=` (§6b): the dashboard, the document list, every `cad/`, `scenes/` or root-level document and the project's assets come from `p/project.json` and the files beside it. There is **no `models.json`, no `scenes/index.json` and no `private-assets/`** any more — a folder name inside the project is a place, not a type. The root of a hosted deploy opens the project's **dashboard**; a document opens through its own `?doc=<id>` link (`settings.defaultModel` is not consulted).

**Opt-in start document (plan-640).** A project can make its hosted root open one document directly, in a mode, instead of the dashboard — without any lock: the dashboard, the editor and every other mode stay reachable through the UI. It is declared in `project.json`, which travels verbatim under `p/`, so no deploy option is involved:

```json
"settings": { "start": { "document": "doc_untitled_gnqvqp", "mode": "hmi" } }
```

- `document` is a document id or path from `documents[]` (or a file name exactly one document carries — the `findStartDocument` rule). `mode` is optional; without it the usual mode cascade applies.
- Precedence: `?doc=` in the link beats `settings.start`, which beats the dashboard; `?mode=` in the link beats `start.mode`. An explicit `?scene=empty` / `?doc=new` still opens an empty scene, while `?mode=planner` alone opens the start document in the planner. A remembered session or active-scene pointer of the visitor's browser is ignored at the hosted root — every visitor of the bare link sees the same document.
- It applies **only to a real hosted deploy**: the generated `settings.json` carries `hostedDeploy: true` (written by `generateHostedSettings`, a reserved key a project file cannot set). A `?projectUrl=` boot elsewhere (dev, agent window, other deliveries) follows the deep-link rule below instead; a local project folder, the CONNECT embed and the kiosk (`mode.lock`) ignore `settings.start`. A deploy published before plan-640 carries no marker and keeps its dashboard until it is republished.
- **Deep link (plan-2018):** a `?projectUrl=<path>` link on a deploy WITHOUT the `hostedDeploy` marker (dev viewer, agent window, an unlocked customer loader) opens the project's start document: `settings.start.document` (in `start.mode`), else `settings.defaultModel` (path, id or unique file name), else the dashboard. `?doc=` and `?scene=` still win, the start beats the implicit planner empty route and the remembered scene, and a heavy CAD model asks first (`guardHeavyRestore`; refusal shows the dashboard). An unresolvable start shows the dashboard with a `projecturl-start-unresolved` Problems warning. Whoever needs the dashboard explicitly for such a link has no `defaultModel`/`start` in `project.json` or uses the dashboard's project list; the marked hosted deploy and the dashboard click are unchanged.
- A `start.document` that names no document keeps the dashboard and puts a `hosted-start-unresolved` warning in the Problems panel; a document that fails to open shows the error card (`hosted-start-failed`) — never a different model. `validate-project.mjs` fails the deploy on an unknown `start.document` before anything is uploaded, and warns on a non-string `mode`.

What the stager does, in order: `validate-project.mjs` (mandatory — a CDN upload cannot be undone, so a committed secret or a broken manifest fails before the build), the filtered private build, the verbatim copy (`copyProjectVerbatim`, with `lstat` — a symlink is never followed, it is skipped and reported), the per-file GLB signing/encryption below, the generated `settings.json`, a printed **preflight** (every document the manifest names — and whether it is on disk —, every removed file with its reason, every skipped symlink, every file above 256 MB), ONE upload pass (`p/**` enters the pool first, `settings.json` goes last with the catalogs), and a reconcile of `{code}/` against the staging listing: whatever the staging did not produce is deleted, a previous layout's `models/`, `models.json` and `private-assets/` included. On success it records `provenance.lastPublishedBy['bunny-private']` with `layout: "hosted-v2"` in `project.json`.

**The deny list** (`_rv-guards.mjs` → `hostedDeployDenyReason()`, one rule for the Bunny deploy and the CONNECT embed): secrets (`isSecretPath`), the folders `.git`, `.trash`, `.cad-cache`, `node_modules`, editor leftovers (`*.bak`, `*.tmp`, OS noise), plugin **sources** (`*.ts`, `*.tsx`, `tsconfig*.json` — the compiled bundle ships in the runtime, the source is realvirtual's), the publish artefact rule (`project-config.json`, `llm.json`, `comments.json`, RAG `index/`/`runtime/`, `*.key`) — and the project's own `.rvprojectignore` on top. `project.json` is **never** removed; the stager refuses to continue if it were.

`settings.json` is generated on top of the project's own `settings/project-settings.json` when it has one. The project file is a **base**: `projectUrl`, `projectAssetsPath`, `hostedDeploy`, `analytics`, `encryption` and `generated` are written afterwards and always win, and a `defaultModel` from it is dropped.

Set the private projects root with `--projects-dir <dir>` or the `BUNNY_PRIVATE_PROJECTS_DIR` environment variable.

### Libraries in deliveries (plan-778)

A project that lists library projects in `libraries[]` (see [doc-projects.md](doc-projects.md#libraries-are-projects-plan-778))
ships them beside itself, **trimmed**: every channel stages
`libraries/<projectId>/` next to the project's `project.json` — the hosted deploy under `{code}/p/libraries/<id>/`,
`deliver.mjs` / the generated customer workspace under `projects/<key>/libraries/<id>/`, the CONNECT embed through
`tools/stage-project.mjs`. One algorithm decides what ships (`src/core/project/rv-library-trim-core.mjs`, Node half
`scripts/lib/rv-library-trim.mjs`, called by the shared stagers `stageFilteredSourceTree` and `stageHostedProject`):

- the qualified `AssetReference`s (and splat `PlacementMeta`) of the shipped documents are followed **transitively**
  through the library documents (depth ≤ 16, cycles harmless); only the documents that are used ship, with their
  thumbnails, **bytes unchanged**; every library a shipped manifest lists ships, trimmed to zero documents when unused;
- the delivered copy's hints are rewritten to `libraries/<id>/project.json` (the sources are never touched), so the
  viewer finds each library relative to the project it opened;
- the **realvirtual library is never trimmed**: it is public and stays the app-level `library/` of every build. The
  hosted stager publishes `library/` only when the project needs it (lists it, places from it, or carries a legacy id
  of it);
- an unqualified (legacy) reference is attributed only inside its own project and otherwise reported once, never fatal;
  a qualified reference that does not resolve, or a library nobody lists, **fails the delivery (exit 1)** naming the
  document and the library, and nothing is written.

**Where the library sources come from** — by id, folder names do not matter:

1. `--library <projectId>=<folder>` (repeatable; `bunny-deploy.mjs --private`, `deliver.mjs`, `publish-project.mjs`,
   CONNECT `stage-project.mjs`);
2. `--projects-dir <dir>` — every project folder in it whose `project.json` carries that id (a delivery defaults to the
   private `projects/` working tree — the working tree, not the Git index);
3. the staged project's own `libraries/` — a re-publish of a delivered copy.

**Checks.** `validate-project.mjs` knows `libraries` as a project folder and refuses a `libraries[]` entry without
`projectId` or `url` and a path-like `projectId` (`/`, `\`, `..`). With `--delivered` (the project's own `libraries/`)
or `--projects-dir` / `--library` it also resolves every library and every qualified reference (exit 1 naming document
and library); without sources it checks the shape only. The register Doctor (`/customers doctor`) reports the same
problems for every customer project that lists a library project other than the realvirtual library.

**Locally:** *Pack with libraries…* in the Projects dashboard's project menu (folder projects, Chromium) writes the same
layout into a picked empty folder — the same trim core, the same rows and hashes as a delivery.

### GLB signing and password protection

Two independent protections can be armed on a deploy. Signing is configured through the environment; the password lives in the **customer register** (plan-759 D6b), with the environment as a one-off override. Neither is ever a CLI argument — arguments land in process lists, shell history and CI logs.

| Source | Effect |
|--------|--------|
| `RV_SIGN_PRIVATE_KEY` (env) | Ed25519 private key (PKCS#8 PEM, or that PEM base64-encoded). Every GLB in the artifact is signed in place with an `rv_sig` provenance signature. Unset = models ship unsigned, and the deploy says so |
| `RV_SIGN_CUSTOMER_CERT` (env) | Path to an `RV-KEY-V1` customer certificate JSON, so the signature is attributed to the customer organisation instead of the realvirtual root key. The certificate's public key must match `RV_SIGN_PRIVATE_KEY` |
| `hosted.password` (register `customers/<slug>.json`) | Encrypts every GLB below `p/` — and the project AASX `aasx/*.aasx` plus `aasx/index.json` (plan-596) — with **AES-256-GCM**. The customer is found through `delivery.projects` |
| `hosted.fragment` (register) | The 32-byte `#k=` link factor, base64url. Absent on the first encrypted publish → the CLI mints one and **writes it back** so the customer's link survives every later publish. Rotating it is a hand edit, never a side effect |
| `RV_DEPLOY_PASSWORD`, `RV_DEPLOY_FRAGMENT` (env) | Override the register halves for one run (a project no register entry claims can only be armed this way) |

Without a password the deploy goes out in plaintext and says so in red. `/customers show` prints the password masked; the doctor warns when a project was published as `hosted-v2` and its entry has no `hosted.password`.

Signing runs over the plaintext GLB first, encryption wraps the signed bytes. Because re-signing and re-encryption are size-preserving, signed and encrypted GLBs deliberately bypass the size-only upload diff.

**Project AASX (plan-596).** With a password, `aasx/*.aasx` (flat, like the viewer's scan) and `aasx/index.json` are encrypted exactly like the GLBs (`encryptablePathsBelow`, same salt, path as `hkdfInfo`). Signing stays on `.glb` — an AASX or a JSON index is never signed. Every file the staging encrypted is uploaded on every publish regardless of its size: the stager reports them `p/`-relative (`aasx/a.aasx`), the deploy translates them to staging paths (`p/aasx/a.aasx`, `hostedForcedUploadRels`) and unites them with the catalog-hash diff. `aasx/index.json` is an always-upload file in any case, encrypted or not. On an unencrypted deploy the viewer opens an AASX with HTTP range reads (directory + the few XML parts); on an encrypted one the whole file is downloaded and decrypted before zip.js reads it — the detail of a large AASX is slower there, the index stays small. `curl` on `p/aasx/<file>.aasx` of a password deploy returns an `RVE1` envelope, not a ZIP header.

**Saved thumbnails (plan-776).** A project's `.thumbnails/<id>.<hash8>.<webp|png>` sidecars travel with the verbatim copy (a dot folder is not on the deny list) and, with a password, are encrypted like the GLBs (`isEncryptablePath`): a picture rendered from a protected model never sits in the clear beside it. The viewer reads them through `BundledBackend.readDocumentUrl`, which decrypts on an encrypted deploy; before the password is entered a card simply shows its placeholder. The app-level library outside `p/` (and its per-category `.thumbnails/`) stays unencrypted, like the library GLBs themselves. Thumbnails are written only by a SAVE: a delivered project is read-only and never writes one, so a project that was never saved on the dev side — and every Unity export — shows placeholders until somebody saves its documents there and redelivers.

The crypto form of a hosted deploy: **one PBKDF2 salt per publish** (one key derivation, held per salt in the tab), every envelope header carries the file's `p/`-relative path as `hkdfInfo` (bound into each chunk's AAD, so chunks of two files under the same key are not interchangeable), 96-bit random IVs per 16 MiB chunk, and a tiny **key probe** in `settings.json` (`encryption.probe`, an envelope over a fixed plaintext with the publish salt). The boot gate derives the key once from the probe's header, verifies it there, and only then reads the project — no document is fetched before the password is right, and a `?doc=` link cannot bypass the gate. Every GLB byte path of the served project (the backend, the blob URLs it hands out, the model cache — which bypasses its persistent blob cache on an encrypted deploy) goes through the one decrypt seam `src/core/persistence/rv-served-bytes.ts`.

The published URL carries the fragment secret:

```
https://web.realvirtual.io/{code}/#k=<fragment>
```

That fragment is **half** the key; the password is the other half and is never logged. Send the link and the password through **separate channels**. `project.json` and the plugin bundle stay plaintext (D4): document names and sizes are readable before the password, the geometry is not.

### Encrypted share link

A single GLB can be shared confidentially **without** building a private deploy per recipient
(plan-560). The share CLI encrypts it into the same RVE1 envelope a hosted deploy uses (password +
`#k=` fragment, AES-256-GCM, 16 MiB chunks), uploads it to the realvirtual fileshare and prints a
link to the **public demo**:

```
https://web.realvirtual.io/demo/?glb=https%3A%2F%2Ffiles.realvirtual.io%2Fdl%2F<token>%2Ffile#k=<fragment>
```

The viewer recognises the envelope in its `?glb=` boot, asks for the password, and opens the model.

```bash
npm run share:encrypt -- model.glb --upload                 # encrypt, upload (30 days), print the link
npm run share:encrypt -- model.glb --upload --expiry-days 0 # permanent link
npm run share:encrypt -- model.glb                          # offline: FRAGMENT + FILE, no upload
npm run share:encrypt -- model.glb --file-url https://cdn.example.com/model.rve.glb   # self-hosted file
npm run share:encrypt -- --link-only --file-url https://…  # link for an already encrypted file
```

| Option / variable | Effect |
|-------------------|--------|
| `--out <file>` | Envelope path; default `<name>.rve.glb` next to the input |
| `--upload` | Upload to the fileshare (create-upload-url → PUT → confirm-upload) |
| `--expiry-days <n>` | Fileshare expiry, default `30`; `0` = permanent |
| `--file-url <url>` | Where the envelope is served when you host it yourself (mutually exclusive with `--upload`) |
| `--base <url>` | Viewer the link opens, default `https://web.realvirtual.io/demo/` |
| `--link-only` | Build a link for an existing envelope — no re-encryption, no new password. Needs `--file-url` and `RV_SHARE_FRAGMENT` |
| `RV_SHARE_PASSWORD` (env) | Password (min. 12 characters). Unset = a random 20-character password is generated |
| `RV_SHARE_FRAGMENT` (env) | `--link-only`: the `FRAGMENT` an earlier run printed |
| `RV_FILESHARE_API_KEY` / `RV_FILESHARE_API_KEY_FILE` (env) | Fileshare Bearer key, or a file holding it (default `E:/firebase-files/.api-key`) |

Output contract: with a file URL stdout carries exactly one line `LINK <viewer link>`; without one
it carries `FRAGMENT <b64url>` and `FILE <path>`. Every encrypting run writes
`PASSWORD (send via a separate channel): …` to **stderr**. Secrets are never arguments, the
fragment is never written to a file, the password never to stdout. **Send the link and the
password through separate channels** — the ciphertext is public and the link alone opens nothing.

What the recipient sees and what it means:

- **Commercial builds only.** The decryptor is a customer-tier feature (`share-decrypt` in
  `tier-manifest.json`), so `/demo` (built with `--demo`) and customer deploys open the link. The
  public/community edition shows *"This model is encrypted and cannot be opened in this edition."*
- **Opened with the password = trusted for this session.** Interface auto-connect and live signals
  are allowed, the trust banner says *"Opened with password — live connections enabled for this
  session."* and offers no revoke. Nothing is stored: no trust-store record, no scene keys.
- **The card.** It shows *Encrypted*; its download hands out the **encrypted** file (plaintext never
  leaves the page as a file); *Open in realvirtual WEB* and *Add to my library* are not offered,
  because both would re-fetch the URL without the key.
- **Errors land on the card:** missing `#k=` → *"The link is incomplete (missing key)."*, Cancel →
  *"Opening was cancelled."*, damaged envelope → *"The file is damaged or was tampered with."* A wrong
  password keeps the prompt open (*"Wrong password or damaged file."* — a damaged first chunk cannot
  be told apart).

Limits: the envelope must stay within the viewer's 250 MB `?glb=` budget (the CLI refuses a larger
one before uploading) and warns above 100 MiB plaintext (mobile browsers). An envelope whose header
demands more than 1,000,000 PBKDF2 iterations is refused without deriving anything. A bare
`https://files.realvirtual.io/dl/<token>` (the human landing page) is pointed at `…/file`
automatically. Every viewer open counts as a fileshare download.

**Prerequisite (open, plan-560 Phase 5):** the fileshare route `/dl/<token>/file` must answer
cross-origin GETs with `Access-Control-Allow-Origin: *` on **every** response (302, OPTIONS, 404/410).
Until the Cloud Function sends it, the browser reports the link as a CORS failure; a self-hosted
envelope (`--file-url`) needs the same header (see *Hosting a GLB for a shared link*).

### Opening a project hosted elsewhere

Because a deploy publishes `project.json`, `models.json` and `scenes/index.json` at its root, any
realvirtual WEB instance can open a project served from another deploy root, read-only:

```
https://web.realvirtual.io/?projectUrl=https://cdn.example.com/customer-xy/
```

realvirtual fetches the manifest from that base and discovers models and example scenes from the two
files beside it. It is read-only by construction — the backend refuses every write — so nothing can
be pushed back at a host you do not own. A base URL that serves no `project.json` is ignored and the
normal project resolution continues; the host must allow cross-origin reads for this to work at all.

> The GLB files themselves are produced in Unity (the realvirtual.io GLB export). This tool deploys existing GLBs — it does not generate them.

> The success line printed in private mode (`https://web.realvirtual.io/{code}/`) is realvirtual's own domain. On your own Bunny account the files upload correctly to your zone, but that printed URL is cosmetic — substitute your own pull-zone hostname.

---

## 4. Credentials

All credentials come from environment variables — there is no key stored in the repo. Copy `.env.example` to `.env` (gitignored) for local use, or provide the values as CI secrets.

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUNNY_STORAGE_KEY` | yes | Storage-zone password (upload / list / delete). No default — committed empty |
| `BUNNY_STORAGE_ZONE` | yes | Storage-zone name. The committed `.env.example` default is realvirtual's own zone — override it with your own |
| `BUNNY_ACCOUNT_KEY` | for purge | Account API key (cache purge). If missing, purge is silently skipped; upload still succeeds |
| `BUNNY_PULL_ZONE_ID` | for purge | Pull-zone id (cache purge). If missing, purge is silently skipped |
| `BUNNY_REGION` | no | Region hostname (default `storage.bunnycdn.com`) |
| `BUNNY_REMOTE_PATH` | no | Public remote path prefix (default empty = storage-zone root) |
| `BUNNY_PRIVATE_PROJECTS_DIR` | no | Private projects root (for `--private`) |
| `GA_MEASUREMENT_ID` | no | GA4 id injected into the deployed `settings.json` (default empty = no analytics) |
| `NEWS_API_URL` | no | Overrides the news feed injected into the deployed public `settings.json` (default `https://download.realvirtual.io/news/api/v1`) |
| `NEWS_DISABLE` | no | `1` injects no news feed at all. Private/customer paths never inject one anyway |
| `RV_PUBLIC_MODEL_PREFIX` | no | Overrides the `project.json` document list for one public deploy (default `DemoRealvirtual,DemoCSGMachining`). Only top-level `models/*.glb` starting with it are published |
| `RV_PUBLIC_TEST_SCENE_PREFIX` | no | Fallback prune prefix for a `dist/` whose manifest has no `devOnly` rows (default `Test`) |
| `RV_SIGN_PRIVATE_KEY` | no | Ed25519 PKCS#8 key (PEM or base64 PEM) used to sign every published GLB. Unset = models ship unsigned |
| `RV_SIGN_CUSTOMER_CERT` | no | Path to an `RV-KEY-V1` customer certificate, so signatures are attributed to the customer org |
| `RV_DEPLOY_PASSWORD` | no | Private deploys: one-off override of the register's `hosted.password` (AES-256-GCM for every GLB). Env only — never a CLI argument |
| `RV_DEPLOY_FRAGMENT` | no | One-off override of the register's `hosted.fragment` (the `#k=` link factor) |
| `RV_BUILD_CACHE` | no | Root for the staged-build `node_modules` cache (default: system temp). Used by `--path dev` / `--path demo-beta` deploys and by `--fast` staged builds, e.g. `scripts/deliver.mjs --fast` |
| `RV_DEPLOY_CONCURRENCY` | no | Parallel storage requests per deploy (default `8`). Stale deletes are capped at 8 regardless |
| `RV_DEPLOY_MAX_INFLIGHT_BYTES` | no | Upper bound for the summed size of files uploading at once, in bytes (default `67108864` = 64 MB). A single larger file uploads alone |
| `RV_KEEP_STAGING` | no | `1` keeps the temporary `rv-customer-workspace-*` staging directory after the deploy — including a failed one — and logs its path |
| `RV_DEPLOY_LOCK_TIMEOUT_SECONDS` | no | How long a public deploy waits for a busy publish lock before it gives up, in seconds (default `1200` = 20 min; `0` = one attempt). The deploy aborts before any remote access |
| `RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS` | no | Upper bound for staging + build of a public deploy, checked right before the publish lock (unset = no limit). The /dev watcher sets `900` for its deploys |
| `RV_DEPLOY_LOCK` | no | `0` publishes **without** the publish lock — honoured only on non-Windows machines, where the named-pipe lock does not exist. Use it only when no other deploy can target the same prefix |
| `VITE_BASE` | no | Build-time base path (default `./`). Settable per-run via `--base` |

These mirror the values configured in the Unity Editor under **Tools > realvirtual > Export > WebViewer Tools** (Publish tab, stored there as EditorPrefs). If you rotate a key, update both places so the two deploy paths stay in sync.

> **`.env.production` wins over `.env`.** `loadDotEnv()` reads `.env.production` **first**, then `.env`, and the first writer of a key keeps it (a value already present in the real shell/CI environment always wins over both). A forgotten `.env.production` therefore silently overrides the `.env` you are editing — including the storage zone you think you are deploying to.

> Only `BUNNY_STORAGE_KEY` is the actual secret, and it is never committed. The `.env.example` zone name is just a default placeholder — without realvirtual's storage key, nothing can be written to realvirtual's account.

---

## 5. Continuous deployment

There is no runner-based CI — deliberately. All deploys run locally via the CLI (`npm run deploy`, `scripts/embed-deploy.mjs`, the deploy skills); the runner-based `.github/workflows/` were removed 2026-08-28. They dated from the retired github-dev repo, only ever executed (and failed) on the public mirror, and Forgejo — today's integration remote — does not run them. A fork that wants CI deployment writes its own workflow around `npm run deploy` with its own Bunny credentials as repository secrets.

The one automatic deploy is realvirtual's internal `/dev` channel: a local watcher on the developer machine publishes every push to `main` — see below.

### Automatic /dev deploys

`https://web.realvirtual.io/dev/` follows `main` on its own (plan-488). A watcher, `scripts/dev-deploy-watch.mjs`, runs as a scheduled task in the developer's Windows session every 3 minutes and at logon. Each tick:

1. takes the watcher's own instance lock (`rv-dev-deploy-watcher`) — a tick still running makes the next one end silently;
2. checks the switch (the file `<root>\enabled`);
3. runs `git fetch origin main` (2 min limit) in **its own two clones** of the WebViewer and the Private repo — never in your working tree. Pushes from any machine, session or worktree count; a push to only one of the two repos is enough;
4. compares the SHA pair with the last deployed one and, when it moved, **reserves** the attempt in `state.json` before anything runs, resets both clones hard to exactly the captured pair (`git clean -ffdxq -e node_modules` — the smoke runtime survives), makes sure the **smoke runtime** of the web clone is current (see [Demo smoke on /dev](#demo-smoke-on-dev)), and runs `scripts/bunny-deploy.mjs --demo --path dev` from the clone as a non-detached child. Several pushes between two ticks collapse into one deploy of the newest pair;
5. books the result: exit `0` is `DEPLOY OK` + the smoke line, exit `3` is `DEPLOY OK` + `SMOKE FAILED` (the pair **is** deployed — no backoff, no redeploy), anything else is `DEPLOY FAILED`.

Every tick writes one line to `<root>\watch.log` (`IDLE`, `DEPLOY START`, `DEPLOY OK … duration=`, `SMOKE OK|FAILED|SKIPPED … failures=<n> (see …smoke-result.json)`, `RUNTIME INSTALL`, `RUNTIME FAILED`, `DEPLOY FAILED`, `GIVING UP`, `FETCH FAILED`, `FETCH RECOVERED after <n> failed ticks`, `STALE LOCK REMOVED <clone>/<path> age=<min>m [(after kill)]`, `STALE LOCK NOT REMOVED …`, `STALE GC PID …`, `LOCK SWEEP REFUSED …`, `NOTIFY FAILED …`, `SKIP …` incl. `SKIP git-locked <clone>/<path> age=<s>s`, `DEFER …`, `TIMING …`); the output of the last deploy is in `<root>\last-deploy.log`. `<root>` defaults to `rv-dev-deploy` next to the workspace root (`<WS>\..\rv-dev-deploy`).

#### Installation

Run the installer **from the canonical checkout** (a worktree or clone is refused), in the Windows session that should run the watcher. Look at the dry run first:

```powershell
Set-Location "Assets\realvirtual-WebViewer~"
node scripts/dev-deploy-watch.mjs --install --dry-run     # prints every step and the task XML, changes nothing
node scripts/dev-deploy-watch.mjs --install               # optional: --root <dir>, --credentials <file> (repeatable)
```

`--install` resolves every path once and writes it absolute into `<root>\config.json` (a clone has no `.plastic` ancestor, so nothing is derived at runtime), clones both repos into `<root>\clones\` with the same `core.autocrlf` as the checkout (so the build cache key matches), copies the watcher, `rv-publish-lock.mjs` and `rv-notify.mjs` to `<root>\bin\`, installs the smoke runtime once (`npm ci --ignore-scripts` in the web clone, `playwright install chromium --only-shell` into `<root>\playwright-browsers\`), creates the switch and registers the task `rv-dev-deploy-watch`. Credentials default to `.env.production` and `.env` of the checkout (first file that sets a key wins, like `npm run deploy`); the watcher hands their values to the deploy as environment and logs only **whether** `BUNNY_STORAGE_KEY`, `BUNNY_STORAGE_ZONE`, `BUNNY_ACCOUNT_KEY` and `BUNNY_PULL_ZONE_ID` are present. Without the two storage keys no deploy starts.

The task runs the **installed copy** in `<root>\bin\`, not the file in the repo: a push that breaks the watcher can only fail one deploy, never stop the automation. After changing `dev-deploy-watch.mjs` run `--install` again — it is idempotent (existing clones are verified, a paused switch stays paused, the task is re-registered).

Task settings: "run only when user is logged on", every 3 minutes plus at logon, no second instance (`IgnoreNew`), **no execution time limit** (a scheduler kill could cut a deploy between stale-delete and purge), runs on battery, never wakes the machine, catches up missed runs. The action is `conhost.exe --headless "<node>" "<root>\bin\dev-deploy-watch.mjs" --config "<root>\config.json"`, so no console window flashes every 3 minutes.

#### Everyday use

```powershell
node <root>\bin\dev-deploy-watch.mjs --status        # switch, status (idle/deployed/in-flight/backoff/failed), last result; --json for scripts
node <root>\bin\dev-deploy-watch.mjs --disable       # pause (removes <root>\enabled); --enable resumes
node <root>\bin\dev-deploy-watch.mjs --retry         # reset the attempt counter of a failed pair
node <root>\bin\dev-deploy-watch.mjs --retry-smoke   # re-run ONLY the demo smoke against the last deployed stand
node <root>\bin\dev-deploy-watch.mjs --uninstall     # remove the task; clones, state and log stay
node <root>\bin\dev-deploy-watch.mjs --purge         # remove the task and delete <root> (refused while a tick runs)
```

**Session binding.** The task only runs while the Windows session exists. Disconnecting an RDP connection keeps the session and the watcher running; signing out or rebooting pauses it until the next logon, whose first tick catches up.

**Failures.** A failed deploy is retried for the same SHA pair after 3 and then 15 minutes — at most **3 attempts**. Then the pair is `failed`, the log says `GIVING UP`, and `/dev` stays as it is until the next push (a new pair always starts again at attempt 1) or `--retry`. The attempt is counted before the deploy starts, so a killed watcher or a crash still uses it up; if `state.json` cannot be written, no deploy starts at all. An unreadable `state.json` also stops deploys (logged as `STATE UNREADABLE`); a corrupt one is moved to `state.corrupt-<timestamp>.json` and the watcher starts fresh. A failed deploy may have changed `/dev` partially — the next successful one synchronizes it completely. Limits apply only **before** publishing: `git fetch` 2 min, staging + build 15 min (the deploy checks it right before taking the publish lock), waiting for the publish lock 20 min. The publish window itself is never cut off.

**Self-heal and blocked notifications (plan-547).** A git that is killed mid-operation (the 2-minute limit force-kills the whole git process tree) leaves its lock file behind, and every later git command in that clone then fails at once — on 2026-09-28 that silently stopped `/dev` for five days. The watcher therefore heals stale locks itself, in two places and only while it holds its own instance lock: right after killing a timed-out git it removes the lock files of **that** clone without any age check (`STALE LOCK REMOVED … (after kill)`), and at the start of every tick, before the fetch, it sweeps both clones (`.git/*.lock`, `.git/refs/**/*.lock`, `.git/objects/info/**/*.lock`, `.git/objects/pack/*.lock`) and removes every lock older than `staleLockMinutes` (`config.json`, default 10). A younger lock is left alone and ends the tick as `SKIP git-locked` — like a failed fetch, it uses no attempt. A stale `gc.pid` is only logged; a clone path that fails the reset guard (not a configured clone, or a junction) is refused and logged. Two situations that need a human now raise a Windows notification once: `GIVING UP` (title *DEPLOY BLOCKED*, with the pair, the error and the `--retry` hint) and the third `FETCH FAILED` tick in a row (title *FETCH FAILING*, with the last error). `state.json` keeps the streak as `fetchFailures`; a successful fetch of both clones resets it to 0, and `--status` shows `fetch fails : <n>` while it is above 0 (`--json`: `fetchFailures`). The installed copy only learns this after `--install`.

#### Speed and machine load (2026-10-25)

A `/dev` deploy runs on the developer PC beside everything else, so the watcher keeps it cheap and out of the way. Every part can be switched off in `<root>\config.json`; a reinstall keeps these keys (`deployArgs`, `lowPriority`, `minFreeMemoryMb`, `deferWhileTestLockHeld`, `testLockPort`, `maxCpuPercent`, `cpuSampleMs`, `maxDeferMinutes`, `prepublishTimeoutSeconds`, `deployTimeoutMs`).

- **Dependency cache.** `/dev` (and `/demo-beta`) build with the shared build cache of `--fast` deliveries: `realvirtual-web/node_modules` is a junction into `<RV_BUILD_CACHE|%TEMP%>\rv-build-cache\<profile>\` when the profile key (lockfiles of core and private package + Node runtime) is unchanged, and `npm ci` runs only on a miss. The profile also keeps the private package's own dependencies (`<profile>\private\node_modules`): a hit **copies** them into `realvirtual-web-pro\node_modules` (a copy, so module resolution sees exactly the `npm ci` layout) instead of running the private `npm ci` (~1 min). `/demo` and every customer deploy keep their fresh `npm ci`.
- **`--dev-fast`** in `deployArgs` (default on a fresh install) is the lighter build profile: `bunny-deploy.mjs` sets `RV_DEV_FAST_BUILD=1` for Vite, which then skips the gzip size report. Source maps stay off and minification stays on (esbuild) like in every deploy. `bunny-deploy` refuses the flag for any target other than `--path dev`. Remove it from `deployArgs` to build `/dev` exactly like `/demo`.
- **Below-normal priority** (`lowPriority`, default `true`): the watcher lowers its own priority before the deploy; git, the deploy child, npm and Vite inherit it, so interactive work and test runs win the CPU.
- **Deferred ticks.** A tick that would deploy is postponed — logged as `DEFER low-memory: free memory 2.1 GB < 3.0 GB`, `DEFER test-lock: …` or `DEFER cpu-busy: CPU 97 % > 85 % over 15 s`, **no attempt used, no backoff** — while free physical memory is below `minFreeMemoryMb` (default 3072, `0` turns it off), while a foreign process holds the machine-wide test lock (`scripts/test-lock.mjs`, port 47177 or `testLockPort`; `deferWhileTestLockHeld: false` turns this off), or while the machine-wide CPU load averaged over `cpuSampleMs` (default 15 000) is above `maxCpuPercent` (default 85, `0` turns it off). Below-normal priority alone does not help against agent dev servers running at normal priority. The next tick decides again. `state.json` → `deferred` records since when a deploy has been pending (a new push does not restart that clock). After `maxDeferMinutes` (default 60) the test lock and the CPU stop deferring it (`DEFER LIMIT … deploying despite test lock / CPU load`), so a machine that is always busy cannot stop `/dev` for good. Low memory still defers.
- **Timing.** Each deploy writes one `TIMING fetch=… reset=… deploy-child=… features=… stage=… deps=… private-deps=… vite-build=… provenance=… postprocess=… lock-wait=… upload=… purge=… probe=… total=…` line into `watch.log`. The watcher measures the first three itself; the rest are the `[timing] <step> <s>s` lines `bunny-deploy.mjs` prints (every run, every target). `deps` includes `private-deps`.
- **Failed logs are kept.** After a failed attempt the watcher copies `last-deploy.log` to `<root>\failed-deploys\deploy-<time>-<web>-<private>.log` (the newest 20 are kept) before the next attempt overwrites it; the `DEPLOY FAILED` line names the copy.

#### Demo smoke on /dev

Every `/dev` deploy runs the [demo smoke](#the-demo-smoke-after-every-public-deploy), so the watcher is also the daily check of `main`: a regression in a public demo shows up minutes after the push.

- **Result.** `state.json` keeps `lastSmoke` (`status`, `reason`, up to 10 failures, `reportPath`) for the pair it belongs to; `--status` shows it as `last smoke : OK|FAILED|SKIPPED <time> <pair> — <first failure>`. The output of the last smoke is in `<root>\last-smoke\` (`smoke-result.json`, `expected.json`, `playwright-report.json`, `artifacts\`), overwritten per run. Exit 3 without a readable `smoke-result.json` is booked as `failed` / `report-unreadable`; a deploy that ran no smoke at all is `skipped`, never `ok`.
- **Notification.** When the smoke turns red (any status → `failed`), a Windows balloon notification names the first failing test and the report path. A lasting red does not notify again; `--status` shows it every time. Notifications come from `rv-notify.mjs` (PowerShell `NotifyIcon`, no module, no npm package) and are visible because the task runs in the logged-on session.
- **Runtime.** The smoke runs from the web clone, which has no `node_modules` of its own. Each tick checks `node_modules/playwright/cli.js`, a `chromium*` folder under `<root>\playwright-browsers\` and the SHA-256 of `package-lock.json` (`state.json` → `runtime.lockHash`); when anything is missing or the lockfile moved, it runs `npm ci --ignore-scripts` and `playwright install chromium --only-shell` (10 min limit each, output in `<root>\last-runtime.log`, log line `RUNTIME INSTALL`). `--ignore-scripts` is required: the `postinstall` would run `npm ci` in the private clone, which has no `.npmrc`. A failed install logs `RUNTIME FAILED` and notifies; the deploy still runs and its smoke then ends `runtime-missing`. The headless shell alone (262 MB) is enough for the smoke.
- **Retry without a deploy.** A smoke that was red for an infrastructure reason is not repeated by the next tick (the pair counts as deployed). `--retry-smoke` runs only the runner against `<root>\last-smoke\expected.json` — the stand the deploy wrote right after its purge, so it exists even when the smoke died at `runtime-missing` — waits for a running tick (watcher lock), books `lastSmoke` for the pair named in that file and deploys nothing. Its output is in `<root>\last-retry-smoke.log`.
- **Smoke off.** `--no-smoke` in `deployArgs` of `<root>\config.json` switches the smoke off for the watcher: no runtime refresh (log `runtime: skipped (smoke disabled)`), no `lastSmoke` booking, and `--retry-smoke` only says the smoke is disabled. A reinstall keeps the existing `deployArgs`.
- **Install once more.** The installed copy only learns all this after `--install` (it copies `rv-notify.mjs` too and writes `browsersPath`/`smokeOutDir` into `config.json`).

#### The publish lock — a contract

Every public deploy (`npm run deploy`, `/deploy-web`, `/deploy-web-beta`, the watcher) holds a lock from **before** listing the remote files until **after** the purge (the zone-root `robots.txt` of `/demo` included), the post-deploy probe and the demo smoke that follow it — a public deploy holds its lock a few minutes longer since plan-503; `--no-smoke` shortens it in an emergency. Without it, a manual `/deploy-web-beta` running while the watcher publishes would list the watcher's fresh assets and delete them as stale. A manual deploy therefore **waits** for a running watcher deploy (`waiting for publish lock rv-publish-…`, up to `RV_DEPLOY_LOCK_TIMEOUT_SECONDS`, default 20 min) and then publishes.

The lock is a **Windows named pipe** owned by the deploy process — the operating system releases it when that process ends, however it ends; there is no lock file to clean up. Its name is the contract between the installed watcher copy and every deploy script version, so it must not change:

| Lock | Name |
|------|------|
| Publish lock of a public deploy | `rv-publish-<storage zone>:<remote prefix>` — zone and prefix lower-cased, prefix without leading/trailing slashes, e.g. `rv-publish-realvitual-web:dev`; the zone root is `rv-publish-<zone>:` |
| Watcher instance lock | `rv-dev-deploy-watcher` |

`/dev` and `/demo` use different locks and never block each other. Names are limited to 200 characters. On a non-Windows machine the publish lock does not exist: a public deploy there refuses to run unless `RV_DEPLOY_LOCK=0` says explicitly that nothing else publishes to the same target.

---

## 6. Two ways to deploy, same result

| Path | When to use |
|------|-------------|
| **Unity — Tools > realvirtual > Export > WebViewer Tools (Publish tab)** | Interactive work in the Editor; uploads the current build with one click |
| **CLI — `npm run deploy`** | No Unity needed; for the console, CI/CD, and automation |

Both produce identical CDN output. The CLI is the Unity-independent path; pick whichever fits the situation.

---

## 6b. The four deploy targets

The two paths above are two ways of reaching the **CDN**. There are four targets in total, and
they differ in one thing that matters more than the transport: **where the project lives, and
therefore what a project update costs.**

| Target | Where the project lives | A project update is | Docs |
|---|---|---|---|
| **CDN** (`web.realvirtual.io`) | as a **folder** under `{code}/p/` next to the runtime (private, plan-759); inside the bundle (public demo) | a re-publish | this file, §2 / §3 |
| **CONNECT embed** | inside the delivered `.exe` | a new build | `Assets/realvirtual-Connect~/doc-connect.md` |
| **Customer workspace** | the customer's own repo, built locally | `npm run build` | §"Customer source delivery" |
| **Appliance** (on-premise box) | served as a **folder**, fed by `git push` | **a push — no build** | `../realvirtual-WebViewer-Private~/appliance/doc-appliance.md` |

The appliance is the odd one out, and deliberately so (plan-721). It serves an immutable
runtime under `app/<version>/` and the project separately under `p/<code>/`, with a generated
~1 KB loader at the origin root pinning exactly one runtime version:

```
/                    -> generated loader:  /app/<version>/?projectUrl=/p/<code>/
/app/<version>/      -> immutable runtime  (Cache-Control: immutable, one year)
/p/<code>/           -> the project tree   (git push -> export -> atomic symlink swap)
```

Two consequences worth knowing even if you never touch a box:

- **The appliance ships NO global `defaultModel`.** Its `project.json` names the start
  document, and the kiosk boot reads it from there (`project.settings.defaultModel`). Every
  other target keeps the baked value, and in a delivered build the two are identical anyway —
  `bareDefaultModel()` derives the global one from the manifest.
- **`generatedSettings()` in `scripts/_workspace-lib.mjs` takes options for this**:
  `omitDefaultModel` leaves the key out entirely, `modeLock` writes the kiosk lock. Both are
  opt-in; without them the function produces exactly the file it always did.

This was the first deploy target of the project-based model, which is why it gets a section
here rather than only in the appliance runbook: a project is a folder with a manifest, not a
bundle with a model baked into it. Since plan-759 the private CDN deploy (§3) and the CONNECT
embed follow the same layout — runtime beside the folder, `settings.json` naming it — with the one
difference that they need no loader: the runtime sits at the root and `projectUrl: "p/"` points
next door.

---

## 6c. A partner publishing into his own zone (plan-603)

A commercial partner with his own projects can publish them **over our CDN** without us
deploying for him and without his own CDN contract. He does not get access to our zone: a
Bunny storage-zone password is scoped to a whole zone, with write **and delete**, so the key
of `realvitual-web` would give him every other customer's private project. He gets a zone of
his own in our account instead.

| | `hosted-link` (§3, plan-759) | **Partner zone** (this section) | Own Bunny account (§"Deploy it yourself") |
|---|---|---|---|
| Who publishes | we do | the partner | the partner |
| Whose infrastructure | ours | ours | his |
| Credential he holds | none | his zone password | his own account key |
| Hostname | `web.realvirtual.io/{code}/` | `<slug>.web.realvirtual.io/{code}/` | his |

**Provisioning (we do this once, in the private repo):**

```bash
node scripts/provision-partner-zone.mjs create --customer <slug> --dry-run
node scripts/provision-partner-zone.mjs create --customer <slug>
```

It creates the storage zone (`rv-partner-<slug>`), a pull zone with a **monthly bandwidth
cap**, the hostname `<slug>.web.realvirtual.io` and its free certificate, then writes zone,
ids, hostname, cap and key into `customers/<slug>.json` (`publishing`). The run is idempotent.
DNS needs to point at Bunny; a single wildcard `*.web.realvirtual.io` covers every partner.
`show` prints the state with the key redacted, `rotate-key` issues a new key, and `revoke`
detaches the hostname and rotates the key — it never deletes a zone or a published file.

**What the partner does.** Nothing new beyond four `.env` lines; the deploy path, the staging,
the `{code}/` isolation and the unguessable path token are the same as §3:

```bash
BUNNY_STORAGE_ZONE=rv-partner-<slug>
BUNNY_STORAGE_KEY=<his zone password>
BUNNY_PRIVATE_PROJECTS_DIR=projects
RV_PUBLIC_BASE_URL=https://<slug>.web.realvirtual.io

npm run deploy:private -- --list
npm run deploy:private -- --project "<name>"
```

`RV_PUBLIC_BASE_URL` is what makes the success line print his hostname. Without it the deploy
would hand him a `web.realvirtual.io` url that does not serve his files.


### What the partner already has in his repository (plan-604)

His delivered workspace carries the publish path itself, so "we provisioned a zone" is the
whole handover — there is nothing to send him afterwards:

| In every delivered workspace | What it is |
|---|---|
| `scripts/publish-project.mjs` + `npm run publish:project` | the CLI: `--list`, `--project`, `--dry-run`, `--no-build`, `--force` |
| `scripts/_bunny-lib.mjs` and its closure (9 modules) | the SHARED staging, diff, client and reconcile contract — the same code this pipeline uses |
| `doc-publishing.md` | the guide: realvirtual-hosted zone, own account, any static host, password protection, troubleshooting |
| `README.md` → Publishing a project | the pointer, so it is found without being told |

What it deliberately does NOT carry is `bunny-deploy.mjs`: the demo allowlist, the SEO
artifacts, the publish lock, the smoke run and the customer register are about operating
`web.realvirtual.io`. Before plan-604 that separation did not exist as code — the register and
the whole delivery machinery hung off `_bunny-lib.mjs` by one import, which is why no publish
path could be delivered at all and the delivered `package.json` advertised a `deploy` script
whose file was never staged. `tests/publish-project.node.test.ts` now fails if either edge
comes back.

Public-facing version of the same material: the documentation site under
**Hosting & Operations → Publishing a Project**
(`Documentation/web/src/content/docs/hosting/publishing-a-project.md`).
Publishing runs **on his machine**, not in CI: our hub (`git.realvirtual.io`) has no Actions
runner, and partner-controlled build code has no business executing next to every customer's
source repository. The GLBs come out of Unity on his machine anyway.

---


## Command reference

| Flag | Effect |
|------|--------|
| `--private` | Private project mode |
| `--demo` | Public demo content, commercial code tier (no `RV_INTERNAL`, no source maps). Mutually exclusive with `--private` |
| `--project <name>` | Project to publish (private mode) |
| `--list` | List private projects and exit |
| `--path <prefix>` | Public remote path prefix (overrides `BUNNY_REMOTE_PATH`) |
| `--projects-dir <dir>` | Private projects root |
| `--base <path>` | Vite base path (`VITE_BASE`), e.g. `/demo/`. Validated by `assertSaneBase()` — see the MSYS warning in [7a](#use-the-built-in-tool-with-your-own-bunny-account) |
| `--force` | Skip the diff, upload everything |
| `--dry-run` | Stage only — build and upload nothing (public prints one line; private prints mode/zone/remote) |
| `--no-purge` | Skip the cache purge |
| `--skip-probe` | Skip the post-deploy probe (plan-508) — for offline or dry runs; normally a probe finding fails the deploy |
| `--no-smoke` | Skip the post-deploy demo smoke (public deploys only; exit code stays `0`) |

`--no-build` was removed: it throws immediately, because a deploy must build from the filtered staging tree.

Tuning through the environment, not flags (see [Credentials](#4-credentials)):

| Variable | Effect |
|----------|--------|
| `RV_DEPLOY_CONCURRENCY` | Parallel uploads/deletes (default `8`) |
| `RV_DEPLOY_MAX_INFLIGHT_BYTES` | Byte budget of the upload pool (default 64 MB) |
| `RV_KEEP_STAGING` | `1` keeps the staging directory, also after a failure |
| `RV_DEPLOY_LOCK_TIMEOUT_SECONDS` | Wait for a busy publish lock (default `1200` s) |
| `RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS` | Staging + build limit before the publish lock (default: none) |
| `RV_PUBLIC_BASE_URL` | Host of the demo smoke URL (default `https://web.realvirtual.io`) |
| `RV_SMOKE_OUT_DIR` | Output dir of the demo smoke (default `<repo>/.smoke/<time>/`; the watcher sets `<root>\last-smoke`) |
| `RV_SMOKE_PAIR` | `{ "web": …, "private": … }` recorded in `expected.json` (set by the watcher) |
| `PLAYWRIGHT_BROWSERS_PATH` | Where the smoke finds Chromium (the watcher sets `<root>\playwright-browsers`) |

Exit codes: `0` OK, `1` deploy failed, `3` deployed but the demo smoke failed — see [The demo smoke after every public deploy](#the-demo-smoke-after-every-public-deploy).

## Customer source delivery

Customer source repositories are generated snapshots, not development mirrors. The generator reads
`tier-manifest.json` from the private WebViewer repository, applies the customer profile from the
customer register (`customers/<slug>.json`, see below; a legacy `delivery/<config>.json` is only a
deprecated fallback), and creates a flat workspace containing `realvirtual-web/`,
`realvirtual-web-pro/`, the customer's `projects/<key>/` directories, and the pinned `connect/` RAG
pair. Internal source and unlicensed restricted features are physically absent.

### Customer register

Who a customer is, what they are entitled to, and where their delivery goes is stated **once**, in
`customers/<slug>.json` in the private WebViewer repository. It is a superset of the older
`delivery/<config>.json` recipe and replaces it: the delivery resolves the register first and only
falls back to a legacy `delivery/` config, with a deprecation warning, while one still exists.

The loader and its invariants live in the public core (`scripts/_rv-customers.mjs`) because the
delivery needs them; the CLI around it stays private. Shape, in short:

```jsonc
{
  "schemaVersion": 1,
  "customer": "acme",             // == the file name (slug), == the hub team name
  "displayName": "ACME GmbH",
  "kind": "development",          // development = own repo, at least one project
                                  // standard    = shared repo, projects MUST be empty
  "support": "basic",             // basic | managed
  "status": "active",
  "forgejo": { "org": "…", "repo": "…", "team": "…", "permission": "write" },
  "contacts": [{ "login": "…", "email": "…", "role": "developer", "status": "active" }],
  "licensing": { "connect": { "issuer": "portal", "key": "LIC-XXXX-XXXX-XXXX" } },
  "delivery": {
    "channel": "git-workspace",   // git-workspace | hosted-link
    "tier": "commercial",         // entitlement profile out of tier-manifest.json
    "restrictedFeatures": [],     // extra restricted features this customer is entitled to
    "projects": ["acme-line1"],   // empty for a `standard` customer
    "connectChannel": "stable"    // CONNECT lane pinned for this customer
  },
  "inference": {                  // optional: the Requesty pair for this customer
    "requestyApiKey": "…",
    "requestyBaseUrl": "https://api.scaleway.ai/v1"
  }
}
```

`kind` and the hub grant are coupled and validated: `development` needs at least one project and
`permission: "write"` in its own `rv-<slug>/rv-project-<slug>` repository; `standard` must have an
empty `projects` array and `permission: "read"`, and is the only kind allowed to share the common
`rv-commercial/realvirtual-commercial` repository — one team per customer, named after the slug.

Everything a delivery needs is IN the entry (2026-09-13): the CONNECT licence as
`licensing.connect.key`, the Requesty pair as `inference`. Both used to sit in a gitignored
`customers/<slug>.secrets.json`, the licence additionally in a SOPS copy in the knowledge base that
no code ever read — three places for one string, synchronised by hand and regularly out of sync.

Neither value is a secret FROM the customer: we issue the licence and hand it over, and `bundle-rag`
embeds the Requesty credentials into their delivered `project-config.json` regardless. The sidecar
bought no protection, only a second mechanism. `REQUESTY_API_KEY` / `REQUESTY_BASE_URL` still win at
run time — a one-off run against another gateway, not a storage location.

The scan for credential-shaped values in the register still runs: `licensing.connect.key` and
`inference.requestyApiKey` are two exact exempt paths, so a token or password anywhere else in the
entry is a hard error, not a warning.

The remote URL is assembled from `forgejo.org` /
`forgejo.repo` plus a hub base URL — the register holds no host name. Resolving that base URL is
two steps and no third (plan-739): the `RV_FORGEJO_HUB_URL` environment override, otherwise
`DEFAULT_HUB_URL` from `scripts/_rv-customers.mjs` — the one place the hub is named, imported both
by `hubBaseUrl()` in `scripts/_workspace-lib.mjs` and by the private `scripts/deliver-release.mjs`,
so a release run and a single delivery cannot disagree about where it is. No caller supplies it any
more: the `delivery/<name>.json` URL fallback that used to sit between the two steps is gone with
those files, and with it the defect that a register-only customer had no legacy file to scavenge a
host name from.

Check the register against the file system before delivering — exit 1 means a real contradiction,
warnings do not gate:

```bash
node ../realvirtual-WebViewer-Private~/scripts/rv-customers.mjs doctor
node ../realvirtual-WebViewer-Private~/scripts/rv-customers.mjs list
```

The full command surface (`list`, `show`, `doctor`, `forgejo-sync`) is documented in
`.claude/commands/customers.md` in the Unity project; onboarding a contact is
`.claude/commands/onboard-customer.md`.

### The territorial rule

**We deliver the application; the customer's projects are theirs.** A customer repository has exactly
one boundary, and it is a folder:

```
rv-project-<customer>/
├── realvirtual-web/          OURS — replaced in full at every delivery
├── realvirtual-web-pro/      OURS
├── connect/                  OURS
├── delivery-manifest.json    OURS — records the version and the baseline tag
└── projects/                 THEIRS
    ├── <key-1>/              seeded once, then only written by an explicit --projects
    ├── demo-realvirtual/     the same rule — no special case since plan-738
    └── <anything they made>/ never read, never written, never reported
```

| Territory | What a delivery does |
|-----------|----------------------|
| Everything outside `projects/` | Deleted and re-copied from the staging tree. Never a file sync: delete-then-copy is what survives a case-only rename and a file↔folder swap on Windows |
| `projects/`, first delivery | Seeded whole — every folder this delivery carries, each one delete-then-copy |
| `projects/`, afterwards | **Nothing**, unless `--projects <name…\|all>` names a folder, and then that folder becomes an exact snapshot of what we ship |

Customer protection comes from Git rather than from our own merge engine: the paths are disjoint, an
update is an ordinary commit on the remote head, and the branch is never force-pushed. The two rules
the generated README states are the whole customer-facing contract — *commit your work before you
pull*, and *we never force-push; the core is ours, `projects/` is yours*.

#### What this replaced, and why

Until plan-738 the repository had three zones with per-file three-way merges, conflict sidecars
(`<name>.vendor-<version>.<ext>`), a `vendor` block per project declaring managed/handover globs, a
`DELIVERY-REPORT.md`, and drift detection. It was not wrong; it was unaffordable. All three
development customer repositories carried **zero** customer-authored files in the delivered project
folders (`git ls-tree` against each, 2026-09-03), so ~600 lines of merge engine plus ~900 lines of
test had to stay correct at every future delivery to protect a case that had never once occurred.
Package managers have never solved the same problem either — `dpkg`'s `.dpkg-new` and RPM's
`.rpmnew` are the same parked-copy compromise.

The `vendor` block is gone from `project.json`. A leftover one in a customer's copy is tolerated in
silence: it is an unknown key now, read by nothing.

### Replacing a project folder on purpose

`--projects` is the only way a delivery writes into `projects/` after the first one, and it is exact:
files we no longer ship are removed, and anything the customer changed is overwritten.

```bash
node scripts/deliver.mjs mauser --push                            # core only; projects/ untouched
node scripts/deliver.mjs mauser --projects mauser3dhmi --push     # replace that one folder, exactly
node scripts/deliver.mjs toray  --projects all --force --push     # unattended, no confirmation
```

- **Names are case-sensitive.** `Toray` is a project and `toray` is a customer slug; a case-only miss
  is refused with the right spelling rather than resolved (`--projects: unknown project "toray" — did
  you mean "Toray"?`).
- **`all` means every vendor project of this delivery plus `demo-realvirtual`** — never "everything in
  `projects/`". No spelling of the flag can reach a folder the customer created.
- **Before anything is deleted**, the delivery lists every file in the customer's current head that
  the replace would overwrite or delete, and stops. The listing runs against the freshly cloned tree
  *before* the replace; run afterwards it would compare the new content against itself and report
  nothing. `--force` applies it unattended.
- **On a first delivery `--projects` is a warned no-op**: the seed writes every folder anyway. That is
  deliberate, so `deliver-release` runs across customers in mixed states without failing.

Exit codes are a contract: `0` delivered (nothing of the customer's needed replacing), `1` a
`--projects` replace was listed and nobody confirmed it, `2` the delivery failed.

### Project scripts are compiled by the delivery (plan-479)

A project may carry its own plugin code, bound to a document by `documents[].scriptRef` (see
[`doc-scripting.md`](doc-scripting.md), *Project code*). On the customer's machine that code is
loaded from a compiled **`.js` sibling** next to the `.ts`, because their viewer build never saw the
source. Producing that sibling is **part of the delivery**, not a step anyone remembers:
`compileStagedProjectScripts()` (`scripts/generate-customer-workspace.mjs`) runs esbuild over every
`scriptRef` of every delivered project **in the staged copy** — the throwaway tree the delivery
assembles anyway, whose contents are committed into the customer clone a few steps later.

Three consequences worth knowing:

- **A script that does not compile stops the delivery**, before anything is committed or pushed. A
  plugin that silently loads nothing at a customer is precisely the outcome this exists to prevent.
- **The private source tree stays clean.** No `.js` is ever written beside the `.ts` in the
  repository, so `deliver.mjs`'s clean-tree assertion still holds and the *next* delivery is not
  broken by this one. `tests/compile-project-scripts.node.test.ts` pins that with `git status
  --porcelain`.
- **`--check` is not the delivery gate.** `npm run build:project-scripts -- <projectDir> --check`
  only reports (exit 3 on missing or stale) and never produces, so on a clean tree it would fail
  every delivery on its first run. Its job is verification **between** deliveries.

### The baseline tag

Every push tags the customer repository `delivery/<version>`. The tag is what answers *has this
repository ever received a delivery?* — scanned for real with `git tag -l 'delivery/*'`, not read as a
name out of `delivery-manifest.json`. That indirection was a genuine hazard: a delivery whose branch
push landed and whose tag push did not leaves a manifest naming a tag that does not exist, "no
baseline" then reads as "first delivery", and a first delivery seeds every project folder over the
customer's work.

The tag also still carries the private-source inventory the tier gate compares against, which is why
`applySnapshot()` returns `baselineTag` with exactly its pre-738 meaning: the manifest's own tag while
it really exists, otherwise the most recent delivery tag that does.

`delivery-manifest.json` is at **v3**. It dropped `vendorGlobs` and `keptByCustomer` — there are no
zones left to describe and no merge outcome to record. A v2 manifest is read, not refused, so the
first delivery after the changeover finds its baseline normally. The other direction is deliberately
unsupported: rolling the code back means reverting the manifest with it.

#### When the tag push did not land

`snapshotPush()` (`scripts/generate-customer-workspace.mjs`) pushes the branch and the tag as **two
separate** Git calls, in this order, with no transaction across them:

```bash
git push origin HEAD:main
git push --force origin refs/tags/delivery/<version>
```

If the run dies in between — a dropped connection, a closed terminal, a hub that goes away — the
delivery is **live at the customer and carries no tag**. That is the one delivery state a re-run
does not repair.

**How to recognise it.** The run's own output stops after the `HEAD:main` push, or the second push
reports an error. Confirm against the remote, not against the log:

```bash
git ls-remote --tags <remote> 'refs/tags/delivery/*'   # the version just delivered is missing
git ls-remote <remote> refs/heads/main                 # but main moved
```

**Why running the delivery again does not fix it.** The core replace is deterministic: it produces
byte-identical content, `git add -A` stages nothing, and `git commit` exits non-zero with *nothing
to commit, working tree clean*. The run aborts there, before it ever reaches the tag push, so the
second attempt leaves the repository exactly as the first one did.

**Recovery** — put the tag on the commit the first run pushed, by hand:

```bash
git clone <remote> rv-tag-recovery && cd rv-tag-recovery
git log -1 --format='%H %s'                          # must be the delivery commit: "viewer <version>"
git tag -f delivery/<version> <sha of that commit>
git push --force origin refs/tags/delivery/<version>
git ls-remote --tags origin 'refs/tags/delivery/*'   # verify it is there now
```

Take the SHA out of the log rather than trusting `HEAD`: if the customer has committed since, `HEAD`
is their commit and the tag still belongs on the delivery. Forcing is not a special measure here —
the delivery force-pushes this tag itself by design, so that re-delivering a corrected build of the
same version needs no manual tag surgery.

**Do it before the next delivery, not later.** The tag is the baseline the next delivery reads, and
it carries the private-source inventory the tier gate compares against. With an older `delivery/*`
tag still present the next run silently falls back to that one and gates against the wrong baseline.
If the failed push was the repository's **first** delivery there is no `delivery/*` tag at all, the
next run reads the repository as a first delivery, and a first delivery seeds every project folder —
over whatever the customer has put there in the meantime.

### Migrating an existing customer repository

The changeover needs no state anywhere and no customer mail (a deliberate decision — the delivery is
passive):

1. Every delivery deletes any leftover `projects/**/*.vendor-*` sidecar. They sit in customer
   territory, so the core replace never reached them, but they are vendor-produced by construction
   and were only ever a copy of something we shipped. The step is idempotent: after the first run the
   glob matches nothing.
2. `DELIVERY-REPORT.md` and the old manifest sit at the repository root, i.e. in our territory, and
   disappear with the first core replace on their own.
3. The commit message of the first delivery under the new model carries a German paragraph explaining
   it. It says itself exactly once — it is keyed on the manifest version that was in the repository
   *before* the delivery, so from the second one on the repository already carries v3.

Before the first real changeover delivery, run it against a throw-away repository on
`git.realvirtual.io` first, and scan each customer repository for leftovers:

```bash
git ls-tree -r HEAD --name-only | grep -E '\.vendor-|DELIVERY-REPORT|delivery-manifest'
```

#### A repository delivered before the demo folder existed never gets it on its own

`projects/demo-realvirtual/` obeys the territorial rule like every other project folder: it is
seeded on the **first** delivery and never written again unless `--projects` names it. A repository
whose first delivery predates plan-737 therefore does not have it, will not get it from an ordinary
delivery, and nothing notices — there is no trigger that detects the state later. Somebody has to
look, and then run the catch-up by hand.

**Look first**, per repository, against the remote:

```bash
git clone <remote> rv-demo-check && cd rv-demo-check
git ls-tree -d --name-only HEAD projects/            # is projects/demo-realvirtual/ among them?
git ls-remote --tags origin 'refs/tags/delivery/*'   # which version the repository last received
```

**Then catch up**, and only with the preview in front of you. `--projects` is exact: the named folder
becomes a snapshot of what we ship, so anything the customer put under `projects/demo-realvirtual/`
is overwritten and anything we no longer ship there is deleted. Since plan-739 the dry run clones,
renders the same before-view the push path renders, and writes nothing at all — no `git add`, no
commit, no tag, no push:

```bash
node scripts/deliver.mjs <slug> --dry-run --projects demo-realvirtual   # preview only, writes nothing
node scripts/deliver.mjs <slug> --projects demo-realvirtual --push      # only after reading the list
```

The preview lists every file the replace would overwrite or delete. If anything on it looks
customer-authored, stop and ask them: the replace has no merge and no sidecar, and after the push
there is no way back other than a corrective delivery.

### Several projects in one repository

`customers/<slug>.json` names the customer and lists their projects:

```jsonc
{
  "customer": "mauser",
  "delivery": { "projects": ["mauser3dhmi", "mauser-line2"] }
}
```

The generated workspace files (README, `settings.json`, start scripts, the CONNECT/RAG payload) are
produced for the primary project only. The delivery is addressed by **customer slug**:

```bash
node scripts/deliver.mjs mauser               # the customer repository, whatever it carries
node scripts/deliver.mjs mauser3dhmi          # a project key still resolves — deprecation warning
node scripts/deliver.mjs --customer mauser    # so does this — deprecation warning
```

Both older forms resolve to the same repository rather than failing: they are typed from memory and
appear in existing scripts, and a hard error would cost a release run to buy nothing.

### What the customer sees

The commit in Forgejo, and the README. There is no `DELIVERY-REPORT.md` any more and no conflict file
to resolve — the delivery either replaced our side (and says which project folders it touched on
stdout) or it did not touch `projects/` at all.

### Publish provenance

`project.json` records each publish target separately under
`provenance.lastPublishedBy['bunny-private' | 'connect-embed' | 'delivery']` (`at`, `version`, and the
target's own identifier). The old single `lastPublished` field stays as a mirror of the most recent
publish — before this, a Bunny deploy erased any record that the project had ever been embedded into a
CONNECT build.

### Release constraints

Every WebViewer release used for delivery must be a clean Git commit tagged
`realvirtual-v<major>.<minor>.<patch>` (for example, `realvirtual-v6.3.0`). The pre-6.3.16 prefix
`viewer-v` is still accepted by the tag pattern so older releases stay deliverable, but every new tag
uses `realvirtual-v`. The private repository must also be
clean. The generated `delivery-manifest.json` records both commits, the entitlement profile, the
project tree hash, and the immutable CONNECT pin. A customer delivery is dry-run by default; a remote
push requires the explicit `--push` option after review.

A project's saved thumbnails (`.thumbnails/<id>.<hash8>.<webp|png>`, plan-776) are ordinary project
files: the delivery carries what Git tracks, so **commit `.thumbnails/` with the project** — an
untracked sidecar stops the delivery like any other untracked file, and a pointer whose sidecar was
not committed shows the placeholder at the customer. The library is delivered per category folder,
and its thumbnails live inside those folders (`library/<Category>/.thumbnails/`), so they arrive with
their category.

#### Release dry-run and receipt (plan-679)

A release proves it can reach **every** target before it is tagged. The order is
`deliver-release --dry-run` → approval → release commit → `--verify-release-commit` → tag → push →
`deliver-release --push --receipt` (driven by `/release-web`).

- **Release check of one target** — `deliver.mjs <slug> --release-check <out.json> --release-version
  X.Y.Z` (no tag required, clean trees only, never combined with `--push`). It runs staging, the guards
  in collect mode (every finding; structure guards — links, nested `.git`, secret file names — do not
  enter the subtree, content guards go on), the build including the third-party notices (the built
  `index.html` must not carry the AGPL watermark), and the tier diff against the target's last
  delivery. The baseline is read with `readRemoteBaselineInventory`: a bare, blob-filtered clone into
  `RV_DELIVER_TMP`, two blobs (`HEAD:delivery-manifest.json` to name the baseline tag, then
  `<tag>:delivery-manifest.json`), a timeout, cleanup in `finally` — nothing is written to the remote.
  A missing diagnosis input is a finding, and the target is still staged, built and checked without the
  package (`diagnosis: failed`, never deliverable). Dependent checks are `not-run: <reason>`, never
  passed. No dependency archive is packed or uploaded. New private files are approval findings, not
  errors. The result file names `target`, both HEADs, `ok`, `checks`, `findings`, `tierDiff`, the
  CONNECT pin, the diagnosis cache key and hashes, and timings.
- **Diagnosis package cache** — `--rag-cache <dir>` (set by `deliver.mjs` on the release path) keys
  `rag.zip` + `project-config.json` by content: project key, seed index, preset, the `docs/` corpus,
  `bundle-rag.mjs`, the `build-rag-index` sources (not its build output), the Requesty base URL and a
  hash of the key. The release push passes `--rag-expect <key>,<zipSha>,<configSha>`; a changed input,
  a missing entry or a tampered file refuses that target with "a new dry-run is needed".
- **Receipt** — `deliver-release --dry-run --release-version X.Y.Z` runs the check for every target
  (shared repository first, then own repositories without diagnosis, then with), keeps going after a
  failure, and writes `RV_DELIVER_TMP/release-X.Y.Z.receipt.json` plus
  `release-X.Y.Z.approval.template.json`. The approval (`release-X.Y.Z.approval.json`: `version`,
  `releaseNotes` = the approved section text, `privateFiles` per target) is also the
  `--accept-private-files` file — the blanket `--accept-new-private-files` is refused on the release
  path.
- **Bound push** — `--verify-release-commit` (before the tag) and `--push --receipt` (again, as the
  backstop) refuse unless the release commit is exactly one commit after the dry-run, changes
  `package.json` only in `version` and `CHANGELOG.md` only by the approved promotion; the push also
  checks both tags and that every private commit after the dry-run is a provenance commit
  (`provenance.lastPublishedBy` only, JSON-compared), and that targets, remotes, options, hub and the
  approval match. Each child gets the receipt's CONNECT pin (`--connect-lock`), the cached diagnosis
  package and the receipt itself.
- **Commit body** — a delivery with a receipt carries the released `CHANGELOG.md` sections between the
  customer's baseline version (`delivery/<version>`) and this one, without `**Internal**`; a missing
  section is an error. A manual single delivery falls back to the feat/fix subject summary.
- **Diagnosis from the register** — only `support: "managed"` customers get the diagnosis package;
  `deliver.mjs` and `deliver-release` derive `--no-rag` for everyone else (`deliversDiagnosis()`), and
  the register doctor fails on a managed project without a preset.

Builds and deployments always run from the filtered staging tree. Reusing an arbitrary `dist/` via
`--no-build` or `-SkipBuild` is disabled. Bunny deployment reconciles the remote snapshot after upload
and removes files that are no longer present locally. Unity Editor and Unity MCP publish commands are
disabled until they can invoke the same filtered Node pipeline.

Generated workspaces contain `start.ps1` and `start.sh`. They install dependencies when necessary,
download the immutable CONNECT version from `connect.lock.json`, verify its SHA-256 hash, and start
CONNECT with `--project-root <workspace>`. CONNECT loads `connect/project-config.json` and
`connect/rag.zip`, verifies bundle hash, embedding model, vector dimensions, and the PDF SHA manifest
before activating a generation. A failed update keeps the previous valid generation active; without a
previous generation, diagnosis stays disabled. It never triggers an automatic re-embedding run.

## Internal ops tooling

The public GitHub remote is a plain mirror of `main`: `git push public main` transfers the tree and
the full commit range, with no filter and no build step in between. `scripts/` therefore holds only
tooling that belongs to the AGPL project — the npm lifecycle helpers (`install-private-dependencies`,
`patch-occt-memory`, `build-local-library-catalog`, `inject-ga-settings`, `test-lock`), fixture and
benchmark generators, and the Bunny deploy CLI, which reads every credential and zone from the
environment (`BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_KEY`, …) and hardcodes nothing.

Tooling that manages realvirtual's own infrastructure or references a customer lives in the private
sibling repository under `../realvirtual-WebViewer-Private~/scripts/`:

| Script | Purpose |
|--------|---------|
| `onboard-customer.mjs` | Forgejo hub account and team management via the rv-bot admin API |
| `get-connect.mjs` | Fetches the pinned CONNECT build (proprietary product) |
| `provision-influx.mjs` | Provisions project-scoped InfluxDB resources for the CONNECT historian |
| `inspect-door.mjs` | One-off diagnostic against a customer GLB |
| `library-zone-setup.mjs` | Idempotent setup of the hosted library storage and CDN zone |
| `library-publish.mjs` | Publishes hosted library projects and probes CDN delivery |

Their tests live in the same repository under `tests/`; `vitest.node.config.ts` includes that
directory when it is present, so `npm run test:node` covers them locally and simply matches nothing
in a public-only checkout. `get-connect.mjs` and `provision-influx.mjs` are still *delivered* into
generated customer workspaces under `tools/` — private to the public remote is not the same as
withheld from customers.

Before publishing, run the guard:

```bash
node scripts/assert-public-safe.mjs
```

It fails when a denied path or an internal marker (hub hostname, knowledge-base path, bot token
variable) is in the tree that would become public, and warns when such a file is absent from the tip
but still present in the unpushed commit range — a plain push publishes that range as readable
history. Publishing only the end state requires a snapshot commit instead of the range; the guard
prints the exact command.

> Two documents that used to live here — the internal bake-picking guide and `PRODUCT.md` — have **moved to
> the private sibling repository** and are no longer in this tree. They are still listed in
> `NEVER_DELIVERED_DOCS` (`scripts/_workspace-lib.mjs`), which is harmless: that constant governs the
> *customer workspace*, and what the *public mirror* publishes is a separate decision. Links to either
> file from a tracked document are now dangling and are reported by
> `node scripts/assert-docs-publishable.mjs`.

### The community-edition precheck (mandatory before a mirror publish)

A community user clones the public mirror: the AGPL core **without** the
`../realvirtual-WebViewer-Private~` sibling, so every `@rv-private/*` import falls through to the
no-op stubs. No part of the normal dev workflow exercises that arrangement — a dev machine always has
the private folder — so a broken stub fallback or a stray hard private dependency only surfaces after
publishing. `precheck-community.mjs` rehearses it locally:

```bash
node scripts/precheck-community.mjs             # tsc + production build + node tests
node scripts/precheck-community.mjs --full      # + the full browser test suite
node scripts/precheck-community.mjs --install   # real `npm ci` instead of linked node_modules
node scripts/precheck-community.mjs --keep      # keep the staged tree for inspection
```

It stages exactly the **git-tracked** files (the working-tree content of tracked paths — no untracked
or ignored files, no NDA models) into a temp directory whose parent contains **no** private sibling,
links or installs `node_modules` there, and then runs `npx tsc --noEmit`, `npm run build` and
`npm run test:node` inside that staged copy. A failure keeps the staged tree and exits 1; do not
publish in that state. This is the gate to pass before publishing the public GitHub mirror
(`/gitweb`), alongside `assert-public-safe.mjs` and `assert-docs-publishable.mjs`.

### Community parity: which typecheck is which

The split is deliberate, not an accident of configuration:

| Command | Config | Sees |
|---------|--------|------|
| `npx tsc --noEmit` | `tsconfig.json` | the **community** view — the private-dependent test files are excluded, so this is what a mirror clone type-checks |
| `npm run typecheck` | `tsconfig.full.json` | everything, including those tests and the private sibling's own tests. **Requires** the private folder |

The exclude block in `tsconfig.json` is **generated** — never edit it by hand. A test counts as
private-dependent when it imports `@rv-private/*` / `@rv-projects/*`, reaches into a private sibling
by path, or carries the `@rv-requires-private` marker. Regenerate after adding or removing such an
import:

```bash
npm run gen:private-excludes     # → tests/private-dependent-tests.json + the tsconfig.json exclude block
```

The same generated list feeds the vitest configs, which skip those files when the private folder is
absent. `tests/private-test-excludes.node.test.ts` fails as soon as the list drifts from the sources.

## See Also

- [README](README.md) — quick start, overview, and [license terms](README.md#license)
- [Debugging Guide](doc-web-debugging.md) — debugging tools and workflow
- [Architecture](doc-webviewer.md) — full architecture and configuration
