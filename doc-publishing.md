# Publishing a project

*How to put a project of this workspace on the web: on the CDN zone realvirtual provisioned for you, or on infrastructure of your own.*

> **Building is not publishing.** `npm run build` produces a `dist/` folder on your machine and uploads nothing. Publishing builds **and** puts the result, together with your project, on a web host. This guide is about the second part.

---

## 1. What gets published

A project publish uploads two things into one folder on your CDN zone:

```
<zone>/<project code>/            the viewer runtime (your build)
<zone>/<project code>/p/          your project: project.json, GLBs, documents, assets
```

`<project code>` is the 32-character code in your `projects/<name>/project.json`. It is random, so the URL is unguessable: there is no login in front of a published project, and the code is what keeps it from being found. Treat the link as the secret it is, and see [Password protection](#4-password-protection) when unguessable is not enough.

The folder is **owned in full** by the publish: files that the current publish does not contain are removed from it. That is what keeps a renamed or deleted document from staying online.

---

## 2. Publishing to the zone realvirtual provisioned for you

If realvirtual hosts your publishing, you were given one storage zone of your own plus the hostname it is served under. The zone password grants write and delete **inside your zone only**; no other content on realvirtual's CDN is reachable with it.

Put the values in a `.env` — either in `realvirtual-web/` or in the workspace root beside `start.ps1`; both are read, and `.gitignore` already covers `.env*`. Keep it that way:

```bash
BUNNY_STORAGE_ZONE=rv-partner-<your slug>
BUNNY_STORAGE_KEY=<the zone password you were given>
RV_PUBLIC_BASE_URL=https://<your slug>.web.realvirtual.io
```

Then, **from `realvirtual-web/`**:

```bash
npm run publish:project -- --list                        # what this workspace has
npm run publish:project -- --project "My Line" --dry-run # every step, uploads nothing
npm run publish:project -- --project "My Line"           # build, stage, upload
```

The last command prints the finished URL. Updates are the same command again: it diffs against what is already on the zone and uploads only what changed.

**Keeping up with realvirtual releases.** Your repository receives new releases from us; `git pull` brings them in, and the next publish ships that version. So the version your users see is the version you merged, not whatever happens to be current elsewhere.

---

## 2b. The usual update: only the model changed

A new GLB out of Unity does not change the viewer, so there is nothing to rebuild:

```bash
npm run publish:project -- --project "My Line" --no-build
```

That skips the build (minutes) and uploads the model only. Two mechanisms make the
"only" exact:

- **Project documents are compared by `sha256`**, not by size. `project.json` carries a
  hash per document, so a re-export with the identical byte count — a renamed signal, a
  changed transform — is still recognised as changed. The publish prints
  `changed: n project document(s) differ by sha256 from what is published`.
- **Everything else is compared by size** and skipped when it matches, so the runtime
  (the bulk of the bytes) is not sent again.

So a model-only publish is: stage locally, one small manifest read, upload that one GLB,
purge the cache. The CDN serves the new model within seconds of the purge.

Use `--no-build` only when `dist/` was built from the current source. After a `git pull`
that brought a new realvirtual release, publish once without the flag.

---

## 3. Publishing to your own infrastructure

The same command works against your own Bunny account — every account-specific value comes from the environment, nothing is hardcoded:

```bash
BUNNY_STORAGE_ZONE=<your zone>
BUNNY_STORAGE_KEY=<your zone password>
BUNNY_ACCOUNT_KEY=<your account api key>   # optional, only to purge the CDN cache
BUNNY_PULL_ZONE_ID=<your pull zone id>     # optional, only to purge the CDN cache
RV_PUBLIC_BASE_URL=https://<your hostname>
```

Without `RV_PUBLIC_BASE_URL` the printed link uses Bunny's system hostname for the zone (`<zone>.b-cdn.net`), which is where the files actually are.

**On a host that is not Bunny**, publish the staged tree yourself: `npm run build`, then serve `dist/` and place your project folder under `p/` beside it, with `settings.json` naming it (`"projectUrl": "p/"`). Three server-side details decide whether it works at all:

| Requirement | Why |
|---|---|
| SPA fallback to `index.html` | the viewer is a single-page app; a deep link must not 404 |
| MIME types for `.glb` (`model/gltf-binary`) and `.wasm` (`application/wasm`) | the loader and the geometry kernel refuse a wrong content type |
| `http(s)`, never `file://` | `GLTFLoader` fetch is blocked at origin `null`, and the camera and XR APIs need a secure context |

Hosting the plain static build (nginx, Apache, S3 + CloudFront, Netlify, Vercel, Cloudflare Pages) is described per host in the project's deployment guide on the public repository.

---

## 4. Password protection

A project can be published encrypted (AES-256-GCM): every GLB is wrapped, and the viewer asks for a password before it shows anything.

```bash
RV_DEPLOY_PASSWORD=<the password your users will type>
npm run publish:project -- --project "My Line"
```

The key is **split**: one half is the password you set, the other half is a fragment the publish prints as `#k=…` at the end of the URL. Both are needed, so send the link and the password through different channels. Keep the fragment (`RV_DEPLOY_FRAGMENT`) if a later publish has to keep an already distributed link working; without it the next publish mints a new fragment and the old link stops decrypting.

---

## 5. Command reference

| Flag | Effect |
|---|---|
| `--list` | lists the projects of this workspace with their codes |
| `--project "<name>"` | the project to publish; the project name or its folder name |
| `--dry-run` | prints every step and the target URL, uploads nothing |
| `--no-build` | publishes the existing `dist/` instead of building first |
| `--force` | uploads every file, skipping the size diff |
| `--projects-dir <dir>` | a projects root other than `projects/` in the workspace root |

| Variable | Required | Purpose |
|---|---|---|
| `BUNNY_STORAGE_ZONE` | yes | the storage zone to publish into |
| `BUNNY_STORAGE_KEY` | yes | that zone's password (write and delete in that zone only) |
| `BUNNY_REGION` | no | storage region host, default `storage.bunnycdn.com` |
| `BUNNY_ACCOUNT_KEY` | no | account API key, only to purge the CDN cache |
| `BUNNY_PULL_ZONE_ID` | no | pull zone id, only to purge the CDN cache |
| `PROJECTS_DIR` | no | projects root, default `projects/` in the workspace root |
| `RV_PUBLIC_BASE_URL` | no | the hostname your zone is served under, for the printed link |
| `RV_DEPLOY_PASSWORD` | no | publish encrypted, password-gated |
| `RV_DEPLOY_FRAGMENT` | no | reuse a previous link fragment |

---

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| `Missing required env BUNNY_STORAGE_ZONE` / `..._KEY` | no `.env` in `realvirtual-web/` or the workspace root, or the variable is empty. `--dry-run` fails the same way, on purpose: it checks the credentials before promising anything |
| `No project "X". This workspace has: …` | the name does not match. Pass the project name from `project.json` or the folder name; `--list` prints both |
| `No build to publish: …/dist does not exist` | `--no-build` was used without a previous build. Run once without it |
| The published page is blank, console shows a 404 for a GLB | the GLB is not committed (Git LFS not installed when the repo was cloned). `git lfs install`, then `git lfs pull` |
| The link asks for a password you did not set | the project was published with `RV_DEPLOY_PASSWORD` earlier; publish again without it to replace the encrypted copy |
| Changes are not visible | the CDN cache still holds the old files. Set `BUNNY_ACCOUNT_KEY` and `BUNNY_PULL_ZONE_ID` so the publish can purge, or purge in the dashboard |

## See also

- [Projects](doc-projects.md) — what a project is, and the manifest that defines it
- [Getting started](doc-getting-started.md) — running the workspace locally
- [Embedding](doc-embedding.md) — putting a published project inside another page
