# Building & Deploying

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

`npm run build` runs `vite build`, writes `dist/`, and stops. The output stays on disk — share it, inspect it, host it yourself (see section 7), or run `npm run preview` against it. Nothing is uploaded.

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

---

## 2. realvirtual's deploy pipeline (publishes to web.realvirtual.io)

> **This is realvirtual's own pipeline.** `npm run deploy` builds the app and uploads it to **realvirtual's** Bunny CDN account, where it goes live at `web.realvirtual.io`. It only writes to that account when `BUNNY_STORAGE_KEY` (realvirtual's secret storage-zone password) is provided. A third party does **not** have that key — a bare `npm run deploy` with no environment configured fails fast with `Missing required env BUNNY_STORAGE_KEY` before anything is uploaded. To publish your own build, point the tool at your own account or host the static files yourself — see [Deploy it yourself](#7-deploy-it-yourself).

`npm run deploy` maps to `node scripts/bunny-deploy.mjs`. It **builds** the app (public build, `VITE_PUBLIC_BUILD=1`) and then **uploads** the result to Bunny CDN.

```bash
npm run deploy                       # build + upload to the configured remote path
npm run deploy -- --path demo        # upload under a specific remote path prefix
npm run deploy -- --dry-run          # stage only; build and upload nothing
npm run deploy -- --demo --path demo --base /demo/   # hosted demo of the COMMERCIAL product
```

`--demo` is the same public deploy with a different **code tier**: instead of the core-only AGPL build it compiles the full commercial feature set (the 15 features a customer receives — asset editor, CAD importers, DES, PLC, physics, machining, IK, …) into the very same public demo site. Everything else is identical: same remote prefix, same model allowlist, same test-scene prune, same GA/news/SEO injection, same signing.

What the demo form does **not** do: it never sets `RV_INTERNAL` (agents and Omniverse are restricted features and stay out), it never emits source maps, and it stages no customer project. The private TypeScript ships as compiled chunks only — a `.map` next to a commercial chunk would be the source code itself, so the deploy refuses to upload any `.map`, `.ts` or `.tsx` found in the build output.

The remote path comes from `BUNNY_REMOTE_PATH` (default empty = storage-zone root, printed as `(root)/`) and can be overridden per run with `--path`.

> **A deploy never uploads the repository's own `dist/`.** It builds from a **temporary, filtered staging workspace** and uploads *that* build. `--no-build` no longer exists: passing it aborts immediately with *"--no-build is disabled: deploys must build from filtered staging."*

What happens, in order:

1. **Stage** — `stageFilteredSourceTree()` (`scripts/_workspace-lib.mjs`) copies an allowlisted source tree into a fresh temp directory (`rv-customer-workspace-*` under the system temp folder). Only the public demo profile (core tier, no project) carries the demo documents and `public/aasx/` along; see [What the public demo ships extra](#what-the-public-demo-ships-extra).
2. **Build in the staging workspace** — `npm ci` **inside that temp workspace**, then `npm run build` with `VITE_PUBLIC_BUILD=1`. The fresh `npm ci` installs into an empty `node_modules` and routinely runs for **several minutes with no output** — that silence is the install, not a hang. The build output is stamped with `.rv-build-provenance.json` (source-tree hash, mode, project) and re-checked by `assertBuildProvenance()` before a single byte is uploaded. Your working `dist/` is neither read nor written.
3. **Model allowlist** — the public CDN ships **only the official demo models**: top-level `models/*.glb` whose filename starts with `DemoRealvirtual` are kept, the planner library under `models/library/**` is always kept, and every other top-level GLB (test fixtures, helper/MU GLBs, stray models) is pruned together with its hashed `assets/` duplicate. `models.json` is rewritten to the kept models so the model selector lists exactly what is shipped. See [Public model allowlist](#public-model-allowlist).
4. **Dev-only prune** — documents the manifest marks `devOnly: true` are dropped from `dist/`, file and manifest row alike. See [Public dev-only prune](#public-dev-only-prune).
5. **Sign + inject** — GLBs are signed when `RV_SIGN_PRIVATE_KEY` is configured (see [GLB signing](#glb-signing-and-password-protection)), then the GA id, the news feed URL and the SEO tags are written into the built artifact only.
6. **Diff** — the remote file list is fetched; unchanged files (same size) are skipped. `*.html`, `settings.json`, `models.json` and `manifest.json` are always re-uploaded, and so is every GLB once signing is active (re-signing is size-preserving, so a size diff would skip it). `*.map` files are never uploaded.
7. **Upload** — changed files are uploaded; assets first, `index.html` last, so the live site never points at missing assets mid-deploy. Remote files that no longer exist locally are then deleted, so the zone matches the build.
8. **Purge** — the CDN cache is purged once (only if something was uploaded, and only when the account/pull-zone purge credentials are present).

> **Tip:** `--dry-run` means different things in the two modes, and the public one is deliberately cheap. A **public** dry run stages the filtered source tree, prints the single line `[dry-run] filtered public source staged; no build/upload performed`, deletes the staging directory and returns — it does **not** build, and it prints **no** allowlist report, no zone and no file list. A **private** dry run does print mode, zone and remote prefix (plus the encryption/signing lines) before it stops short of staging and uploading.

### What the public demo ships extra

`includePublicDemoContent` (`scripts/_workspace-lib.mjs`) is the one staging switch that separates realvirtual's own demo from a customer artifact. It is on for the two **hosted demo** forms — the plain public deploy (core tier, no project key) and `--demo` (commercial tier, no project key), which passes it explicitly — and it is what lets the demo **documents** — `public/*.glb` named by `public/project.json`, DemoRealvirtualWeb and DemoPlanner among them — and `public/aasx/` (the AAS supplier demos: Festo, SEW, Bosch) into the staged tree. (`public/scenes/` was a second, curated Examples catalogue beside the manifest; plan-731 removed the folder and its `index.json`.) Every customer delivery and every private project deploy filters both out: they are demo content, not product.

The `--demo` staging differs from a customer delivery in one more way: `workspaceFiles: false`. A CDN deploy publishes code, not a repository, so no README, setup/start scripts, recipes or CONNECT helpers are generated — and the core `public/settings.json` survives untouched, which is the artifact the GA and news injection then writes into.

### Every channel ships a manifest (plan-735)

There is no longer any channel on which the viewer works out what it has by looking around. Each one publishes a `project.json` at its deploy root, and that file is the only statement of what the delivery contains:

| Channel | Where its `project.json` comes from |
| --- | --- |
| Dev checkout | `public/demo-realvirtual/project.json`, checked in (plan-737) |
| Bunny public / `--demo` | `public/demo-realvirtual/` → `dist/demo-realvirtual/` (Vite copies `public/` recursively) |
| CONNECT embed | `public/demo-realvirtual/` → payload — **`realvirtual-Connect~/tools/stage-public.mjs` still expects the pre-737 root layout and must be updated in its own lane before the next CONNECT bundle** |
| Customer, project-bearing | `projects/<key>/project.json`, plus their own `models.json` on a CDN deploy |
| Customer, projectless (`kind: standard`) | **generated at staging time** into `realvirtual-web/public/project.json` |
| Foreign host (`discover: true`) | its own `project.json` — otherwise there is no project (see below) |

Two consequences worth knowing before you touch a staging script:

- **The build-time glob is gone.** `import.meta.glob('/public/models/*.glb')` used to seed the model catalogue from whatever sat in the dev checkout, and `BundledBackend` used to turn that into a synthetic project when a deploy had no manifest. Both are removed. A deploy root that serves no readable `project.json` has **no project**: `readManifest()` returns `null` and logs a named line naming the three causes it cannot tell apart (404, CORS, `file://`). This includes a *foreign* host that publishes `models.json` but no manifest — a deliberate, accepted narrowing of plan-700 F12.
- **The generated projectless manifest is vendor-owned and lives in Zone A.** It is written by `writeGeneratedDeliveryManifest()` in `scripts/_workspace-lib.mjs`, *after* `copyCore()` has filtered the demo's own `public/project.json` out of the delivery — the order is load-bearing, since generating it earlier would delete it. It carries a `_generated` header saying so, the delivered README repeats it, and every update replaces it wholesale. There is no sidecar protection and none is intended: a standard customer who wants documents of their own creates a project under `projects/`, which is the only place an update never touches.

### Public model allowlist

A public deploy publishes only the official demo models. `public/models/` in the dev tree may hold test fixtures, helper GLBs, and work-in-progress models; none of those should reach the public CDN. (Since plan-735 they are also simply invisible to the viewer unless a manifest declares them — the folder is storage, not a catalogue.)

**Since plan-726 the curator is the demo's own manifest**, `public/project.json`. Its `documents[]` is the single source of truth for what the demo contains, on every channel — the hosted site, the CONNECT bundle and the dev checkout all boot from that one file — so the deploy reads it instead of keeping a second, independent list. The old filename prefix survives underneath it, in two roles that are still needed: as the answer for a `dist/` that carries no manifest, and as the `RV_PUBLIC_MODEL_PREFIX` override.

Precedence, highest first:

1. `RV_PUBLIC_MODEL_PREFIX` — an operator overriding one deploy. It stays on top so it remains a usable rollback lever.
2. `dist/project.json` `documents[]` — the demo's own statement of what it is.
3. The built-in prefix list — only for a `dist/` with no manifest at all.

> This fixed a live defect. `DemoRobotIK.glb` is a demo model and is listed in the manifest, but it matches neither built-in prefix — so every public and `--demo` deploy before plan-726 silently deleted it before upload.

The rule, applied to the built `dist/` after the build and before upload:

- **Kept** — the `models/*.glb` the manifest declares (or, without a manifest, top-level `models/*.glb` whose filename starts with `DemoRealvirtual`), plus the entire planner standard library under `models/library/**`.
- **Pruned** — every other top-level `models/*.glb` and the content-hashed copy Vite also emits under `assets/`. The hyphen-boundary match means pruning e.g. `EuropalletEmpty` never touches the library's `Europallet*` assets.
- **`models.json`** — rewritten to the kept models so the model selector shows exactly what is shipped (the build-time glob otherwise bakes every dev GLB filename into the selector, leaving 404 ghost entries).

The prune is logged (`keep` / `prune` lines), with the curator named on the header line so it is visible which of the three rules applied. **To ship a model on the public demo, add it to `public/demo-realvirtual/project.json`** — the filename no longer matters. Override the manifest for one deploy with the `RV_PUBLIC_MODEL_PREFIX` environment variable. This applies to the **public** deploy only — private projects already stage their own models, and a plain `npm run build` for self-hosting keeps every model. (A public `--dry-run` never reaches this step, see the tip above.)

### The demo manifest is a deploy artifact

`public/project.json` ships to the deploy root and is read there by
`BundledBackend.readManifest()`. Three consequences worth knowing:

- **It is never cached like a build asset.** It lives at a fixed URL and a
  curator's edit — renaming a document, swapping the start document — routinely
  leaves the byte count unchanged, so a size-only diff would skip it. It is in
  `ALWAYS_UPLOAD_FILES` and the pull zone is purged after the upload. The client
  fetches it with `cache: "no-cache"` (revalidate, 304 on an unchanged file) —
  never `immutable`.
- **A contradiction aborts the deploy.** After both pruning passes,
  `publicDemoManifestMisses()` checks that every `models/` and `scenes/`
  document the manifest names is actually in `dist/`. The comparison is
  case-sensitive, because the storage zone is: a `Models/…` typo passes on a
  Windows dev machine and 404s on the CDN. This runs on the **public** path only
  — a private customer deploy publishes no root manifest.
- **It never reaches a customer delivery.** `copyCore()` filters it out
  alongside `scenes/` and `aasx/` unless `includePublicDemoContent` is set. It
  needed its own filter branch: every other exclusion there matches a
  subdirectory, and a top-level file would sail straight past them onto the
  customer's deploy root — where it would be read as *their* project.

**Rollback** is cheap for content mistakes and expensive for code ones. The
difference matters enough to have its own runbook — see below.

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

`RV_PUBLIC_MODEL_PREFIX` sits **above** `dist/project.json` in the precedence
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

Private customer projects publish to an unguessable URL `web.realvirtual.io/{code}/`, isolated from the public demo. Each project lives in its own folder under the private projects directory and carries its own GLB models.

```bash
npm run deploy:private -- --list                       # list available private projects
npm run deploy:private -- --project "Customer XY"      # build + publish one project
```

The private deploy stages the build together with the project's own GLBs (the public demo models are excluded), generates the project `settings.json` and `models.json`, uploads everything to `{code}/`, and uploads any extra project assets to `{code}/private-assets/`. On success it records the publish under `provenance.lastPublishedBy['bunny-private']` in `project.json` (and mirrors the timestamp into the legacy `lastPublished` field).

What comes from where:

| Published file | Source |
|----------------|--------|
| `models.json` | **The `models/` folder UNION the manifest's root-level GLB documents** (`projectModelNames()`, plan-720). The folder can never be shortened by the manifest — every GLB in `models/` belongs to the project and nobody should have to register one (plan-700 P0-3). It can only be LENGTHENED, by a `documents[]` entry naming an existing root-level `.glb`, which is the layout the viewer writes today and which the folder glob structurally cannot see. Entries under `scenes/`/`library/` are excluded — those folders are staged whole. A declared file that is missing, or a folder GLB with no manifest row, is logged rather than silently dropped |
| `scenes/index.json` | The manifest's scene documents (`documentsInSection(project, "scenes")` — a legacy projection, see doc-persistence §2.0-13), for entries marked `baseKind: "published"` whose `path` is a `.glb` directly under `scenes/`. A project whose manifest lists none keeps whatever `index.json` its `scenes/` folder already had. **Legacy since plan-731:** realvirtual's own deploys ship no such file — their examples are ordinary `documents[]` rows. It is still written for a customer project that keeps its scenes in a folder, and still READ by a `discover` backend pointed at a foreign root |
| `settings.json` | Generated, on top of the project's own `settings/project-settings.json` when it has one. The project file is a **base**: `projectAssetsPath`, `analytics`, `encryption` and `generated` are written afterwards and always win, so a project file can add settings but can never re-enable analytics or aim the assets path elsewhere |

Every private deploy — and every public one, and every CONNECT embed — runs `validate-project.mjs`
first. A CDN upload cannot be undone, so a committed secret or a broken manifest has to fail before
the build, not be noticed after it.

Set the private projects root with `--projects-dir <dir>` or the `BUNNY_PRIVATE_PROJECTS_DIR` environment variable.

### GLB signing and password protection

Two independent protections can be armed on a deploy. Both are configured **only** through the environment — never as a CLI argument, because arguments land in process lists, shell history and CI logs.

| Env | Effect |
|-----|--------|
| `RV_SIGN_PRIVATE_KEY` | Ed25519 private key (PKCS#8 PEM, or that PEM base64-encoded). Every GLB in the artifact is signed in place with an `rv_sig` provenance signature. Unset = models ship unsigned, and the deploy says so |
| `RV_SIGN_CUSTOMER_CERT` | Path to an `RV-KEY-V1` customer certificate JSON, so the signature is attributed to the customer organisation instead of the realvirtual root key. The certificate's public key must match `RV_SIGN_PRIVATE_KEY` |
| `RV_DEPLOY_PASSWORD` | Private deploys only. Encrypts the project's GLBs with **AES-256-GCM** |
| `RV_DEPLOY_FRAGMENT` | Reuses a given 32-byte fragment secret instead of generating a fresh one, so an in-place re-publish keeps the existing link working |

Signing runs over the **final** artifact set, after the allowlist and prune steps, on both the public and the private path. Because re-signing and re-encryption are size-preserving, signed and encrypted GLBs deliberately bypass the size-only upload diff.

With `RV_DEPLOY_PASSWORD` set, the published URL carries the fragment secret:

```
https://web.realvirtual.io/{code}/#k=<fragment>
```

That fragment is **half** the key; the password is the other half and is never logged. Send the link and the password through **separate channels**. Without `RV_DEPLOY_FRAGMENT`, every re-publish mints a new fragment and invalidates the old link.

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
| `RV_DEPLOY_PASSWORD` | no | Private deploys: AES-256-GCM password protection for the project's GLBs. Env only — never a CLI argument |
| `RV_DEPLOY_FRAGMENT` | no | Reuses an existing fragment secret so the `#k=` link survives a re-publish |
| `RV_BUILD_CACHE` | no | Root for the staged-build `node_modules` cache (default: system temp). Only used by `--fast` staged builds, e.g. `scripts/deliver.mjs --fast` |
| `VITE_BASE` | no | Build-time base path (default `./`). Settable per-run via `--base` |

These mirror the values configured in the Unity Editor under **Tools > realvirtual > Export > WebViewer Tools** (Publish tab, stored there as EditorPrefs). If you rotate a key, update both places so the two deploy paths stay in sync.

> **`.env.production` wins over `.env`.** `loadDotEnv()` reads `.env.production` **first**, then `.env`, and the first writer of a key keeps it (a value already present in the real shell/CI environment always wins over both). A forgotten `.env.production` therefore silently overrides the `.env` you are editing — including the storage zone you think you are deploying to.

> Only `BUNNY_STORAGE_KEY` is the actual secret, and it is never committed. The `.env.example` zone name is just a default placeholder — without realvirtual's storage key, nothing can be written to realvirtual's account.

---

## 5. Continuous deployment

There is none — deliberately. All deploys run locally via the CLI (`npm run deploy`, `scripts/embed-deploy.mjs`, the deploy skills); the runner-based `.github/workflows/` were removed 2026-08-28. They dated from the retired github-dev repo, only ever executed (and failed) on the public mirror, and Forgejo — today's integration remote — does not run them. A fork that wants CI deployment writes its own workflow around `npm run deploy` with its own Bunny credentials as repository secrets.

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
| **CDN** (`web.realvirtual.io`) | inside the published bundle | a re-publish | this file, §2 / §3 |
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

This is the first deploy target of the project-based model, which is why it gets a section
here rather than only in the appliance runbook: the direction of travel is that a project is a
folder with a manifest, not a bundle with a model baked into it.

---

## 7. Deploy it yourself

realvirtual WEB is the open standard for browser-based 3D HMI in manufacturing. You can run your own deployment two ways: reuse the built-in tool with your own Bunny account, or treat the build as plain static files and host them anywhere.

> **AGPL obligations apply to self-hosting.** realvirtual WEB is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. Deploying it on your own infrastructure — including serving it as a network service — triggers the AGPL: you must publish your **complete project** under AGPL-3.0 and make it freely available. This includes all source code, configuration, and **all content delivered through the application**, such as GLB model files, `settings.json`, and plugins. This applies whether the application is served over a network or distributed directly.

> The "Powered by realvirtual WEB" watermark and the realvirtual logo must remain visible and unmodified in all AGPL deployments. Removing or modifying branding requires a commercial license.

> **Keeping a project private?** To self-host with proprietary models, private configuration, or closed plugins — or to remove branding — use a [commercial license](https://realvirtual.io/en/company/license). See the [README license section](README.md#license) for the canonical terms.

### 7a. Use the built-in tool with your own Bunny account

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

### 7b. Host the static `dist/` anywhere

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
| **SPA fallback** | A hard refresh on a deep link must return `index.html` (HTTP 200), not 404. Use `try_files`/rewrite/`_redirects`/`404.html` per host. A blanket fallback also turns missing assets into HTML 200s — scope it if you want real `/assets/*` 404s |
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

## Command reference

| Flag | Effect |
|------|--------|
| `--private` | Private project mode |
| `--demo` | Public demo content, commercial code tier (no `RV_INTERNAL`, no source maps). Mutually exclusive with `--private` |
| `--project <name>` | Project to publish (private mode) |
| `--list` | List private projects and exit |
| `--path <prefix>` | Public remote path prefix (overrides `BUNNY_REMOTE_PATH`) |
| `--projects-dir <dir>` | Private projects root |
| `--base <path>` | Vite base path (`VITE_BASE`), e.g. `/demo/`. Validated by `assertSaneBase()` — see the MSYS warning in [7a](#7a-use-the-built-in-tool-with-your-own-bunny-account) |
| `--force` | Skip the diff, upload everything |
| `--dry-run` | Stage only — build and upload nothing (public prints one line; private prints mode/zone/remote) |
| `--no-purge` | Skip the cache purge |

`--no-build` was removed: it throws immediately, because a deploy must build from the filtered staging tree.

## Customer source delivery

Customer source repositories are generated snapshots, not development mirrors. The generator reads
`tier-manifest.json` from the private WebViewer repository, applies the customer profile from
`delivery/<config>.json`, and creates a flat workspace containing `realvirtual-web/`,
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
  "licensing": { "connect": { "issuer": "portal", "keyRef": "connectLicenseKey" } },
  "delivery": {
    "channel": "git-workspace",   // git-workspace | hosted-link
    "tier": "commercial",         // entitlement profile out of tier-manifest.json
    "restrictedFeatures": [],     // extra restricted features this customer is entitled to
    "projects": ["acme-line1"],   // empty for a `standard` customer
    "connectChannel": "stable"    // CONNECT lane pinned for this customer
  },
  "secretsRef": "customers/acme.secrets.json"
}
```

`kind` and the hub grant are coupled and validated: `development` needs at least one project and
`permission: "write"` in its own `rv-<slug>/rv-project-<slug>` repository; `standard` must have an
empty `projects` array and `permission: "read"`, and is the only kind allowed to share the common
`rv-commercial/realvirtual-commercial` repository — one team per customer, named after the slug.

Secret values are **never** in the register: `connectLicenseKey`, `requestyApiKey` and
`requestyBaseUrl` resolve from the environment first, then from the gitignored
`customers/<slug>.secrets.json` (`secretsRef`). A credential-shaped value found inside the register
itself is a hard error, not a warning. The remote URL is assembled from `forgejo.org` /
`forgejo.repo` plus a hub base URL the caller supplies (`RV_FORGEJO_HUB_URL`) — the register holds
no host name.

Check the register against the file system before delivering — exit 1 means a real contradiction,
warnings do not gate:

```bash
node ../realvirtual-WebViewer-Private~/scripts/rv-customers.mjs doctor
node ../realvirtual-WebViewer-Private~/scripts/rv-customers.mjs list
```

The full command surface (`list`, `show`, `doctor`, `forgejo-sync`) is documented in
`.claude/commands/customers.md` in the Unity project; onboarding a contact is
`.claude/commands/onboard-customer.md`.

### The three zones

A customer repository is not one block. Since plan-700 it has three zones, each with its own update
rule, because the project folder is *simultaneously* our deliverable and the customer's working file.
Before this, the whole of `projects/<key>/` was preserved byte-for-byte — which meant no
project-side update ever reached a delivered customer again — while everything outside it was deleted
and replaced without a word.

```
rv-project-<customer>/
├── realvirtual-web/          ZONE A — ours, replaced every delivery
├── realvirtual-web-pro/      ZONE A
├── connect/                  ZONE A
├── delivery-manifest.json    ZONE A — carries the merge basis
├── DELIVERY-REPORT.md        ZONE A — regenerated every delivery
└── projects/
    ├── <key-1>/
    │   ├── models/ docs/ connect/ …   ZONE B — ours, three-way merged
    │   ├── scenes/ settings/ layouts/ ZONE C — the customer's, never touched
    │   └── project.json               ZONE B+C — merged field by field
    └── <key-2>/ …
```

| Zone | Rule | On conflict |
|------|------|-------------|
| **A** — everything outside `projects/**` | Replaced on every delivery | Customer changes are detected against the previous delivery tag and **listed in the report**; the replacement still happens |
| **B** — the `vendor.managed` globs inside a project | Three-way merged against the previous delivery | **The customer's version wins.** Ours is parked beside it as `<name>.vendor-<version>.<ext>` and named in the report |
| **C** — everything else inside a project | Never written | — |

The default is deliberately asymmetric: **anything unclassified is Zone C**. A forgotten vendor glob
costs one update that did not arrive; a glob that is too wide costs the customer's work. Only the
first mistake is repairable.

### The `vendor` block

Zone B is declared per project, in its `project.json`:

```jsonc
"vendor": {
  // Ours. Merged on every delivery.
  "managed": ["models/**", "library/**", "docs/**", "connect/**", "plugins/**", "rag/**"],
  // Exceptions INSIDE managed that belong to the customer. These win.
  "handover": ["connect/secrets.local.json", "models/custom/**"]
}
```

A project with no `vendor` block is entirely Zone C — the pre-plan-700 behaviour, so nothing breaks by
omission. `validate-project.mjs` refuses `**`, a bare `*`, and any glob that could reach `scenes/`,
`settings/` or `layouts/`; that check runs before every delivery and every deploy, not in a review
checklist. Sidecars are always Zone C, so the next delivery never cleans up the copy it left behind —
removing one is the customer's decision.

### The merge basis

Every push tags the customer repository `delivery/<version>`. That tag **is** the basis the next
delivery merges against: the customer repository already keeps a complete, trustworthy hash tree, and
a second one carried in JSON would be ~150 KB of churn per delivery that still could not see files the
customer created on their own. Blob OIDs are read straight out of Git (`git ls-tree` for the basis,
`git ls-files -s` for both working sides), which is immune to LFS smudge state, CRLF conversion and
Windows' case folding all at once.

Two situations have no basis, and they are not the same:

| Situation | What happens |
|-----------|--------------|
| Remote is empty (first delivery) | Full seeding — everything is written, nothing is reported |
| Remote has content but no `delivery/<version>` tag | Files present on both sides are left alone. Vendor files **missing** at the customer are **not** silently created; they are reported as `add-pending`, because "never delivered" and "deleted on purpose" look identical without a basis. `--seed-missing` creates them after a human has read the report |

**For the two existing customers this means the first delivery after plan-700 delivers nothing into
Zone B.** It sets the basis and reports what is missing; the second delivery brings the updates. Say
so when delivering, or pass `--seed-missing` deliberately.

### Several projects in one repository

`delivery/<config>.json` names the customer and lists their projects:

```jsonc
{
  "customer": "mauser",
  "projects": ["mauser3dhmi", "mauser-line2"],   // absent → [<filename>]
  "tier": "commercial",
  "remote": "https://git.realvirtual.io/rv-mauser/rv-project-mauser.git"
}
```

`project` stays what it always was — the display name ("Mauser 3D HMI") — and is **not** the key.
Merge, guards, manifest and report work per project; the generated workspace files (README,
`settings.json`, start scripts, the CONNECT/RAG payload) are still produced for the primary project
only. A project key resolves against every config, and an ambiguous key throws rather than guessing.

```bash
node scripts/deliver.mjs mauser3dhmi          # by project key
node scripts/deliver.mjs --customer mauser    # every project of that customer
```

### What the customer sees

`DELIVERY-REPORT.md`, in German, at the repository root, regenerated every time: conflicts (their
version was kept, ours is at *this* path), what was updated, added and removed, and their own changes
outside `projects/`. A short version goes into the commit message so it is visible in Forgejo, and
onto stdout. **A conflict exits 0** — it is a normal outcome, not a failure. Only guard violations
abort.

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

> Two documents that used to live here — `doc-render-picking.md` and `PRODUCT.md` — have **moved to
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
