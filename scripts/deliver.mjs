// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * One-shot customer delivery wrapper.
 *
 * Replaces the long-form invocation
 *   node scripts/generate-customer-workspace.mjs --project <k> --push \
 *     --seed-index <...> --diagnosis-config <...> --connect-lock <tempfile>
 * with
 *   node scripts/deliver.mjs <projectKey> --push [--fast] [--dry-run]
 *
 * It runs the provenance preflight up front (clean trees + release tag), auto-resolves
 * the three long path arguments (diagnosis preset, RAG seed index, CONNECT pin), then
 * spawns generate-customer-workspace.mjs and forwards its exit code.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG_PATTERN, loadDeliveryConfig, loadDeliveryConfigByCustomer, readPlasticChangeset } from './_workspace-lib.mjs';
import { assertValidProject } from './validate-project.mjs';
import { ragSeedIndex, tmpDir } from './lib/rv-machine-paths.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(scriptDir, '..');
const privateRoot = resolve(coreRoot, '../realvirtual-WebViewer-Private~');
const presetsDir = resolve(coreRoot, '../realvirtual-Connect~/tools/presets');
const generator = join(scriptDir, 'generate-customer-workspace.mjs');

// Both defaults derive from the workspace root (the directory holding `.plastic`), so the
// same command works from every developer checkout — E:\realvirtual6 and
// C:\Users\<user>\wkspaces\game4automation-release alike. See scripts/lib/rv-machine-paths.mjs.
const DEFAULT_SEED_INDEX = ragSeedIndex();
const DEFAULT_TMP = tmpDir();
// The one definition, shared with gitProvenance() in _workspace-lib.mjs — two copies had already
// drifted apart from the tag scheme once. It accepts the current `realvirtual-v` prefix and the
// pre-6.3.16 `viewer-v` one alike.
const RELEASE_TAG = RELEASE_TAG_PATTERN;

//! Preflight/resolution failures throw this so the top-level handler can print a clean message.
class DeliverError extends Error {}

function fail(message) {
  throw new DeliverError(message);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function assertCleanTree(label, dir) {
  if (!existsSync(join(dir, '.git'))) fail(`${label} is not a git repository: ${dir}`);
  const status = git(['status', '--porcelain'], dir);
  if (status) {
    const count = status.split(/\r?\n/).filter(Boolean).length;
    fail(`${label} has ${count} uncommitted change(s):\n  ${dir}\n  Commit or stash them first — deliver never auto-commits.`);
  }
}

function assertReleaseTag(dir, version) {
  const tags = git(['tag', '--points-at', 'HEAD'], dir).split(/\r?\n/).filter(Boolean);
  if (!tags.some((tag) => RELEASE_TAG.test(tag))) {
    fail(`Core HEAD carries no realvirtual-vX.Y.Z release tag:\n  ${dir}\n  Tag the release first, e.g.: git -C "${dir}" tag realvirtual-v${version}`);
  }
}

/**
 * Resolves what is to be delivered, from either form of the request.
 *
 * The config file name is no longer the project key (§2.10): one file may name a
 * customer and several of their projects. `deliver.mjs <projectKey>` therefore
 * asks "which config claims this key?" rather than reading a same-named file,
 * and `deliver.mjs --customer <name>` delivers that customer's whole repository.
 */
function resolveDelivery({ projectKey, customer }) {
  let config;
  try {
    config = customer
      ? loadDeliveryConfigByCustomer(privateRoot, customer)
      : loadDeliveryConfig(privateRoot, projectKey);
  } catch (error) {
    fail(customer
      ? `No delivery config for customer "${customer}":\n  ${error.message}`
      : `Cannot resolve project "${projectKey}":\n  ${error.message}\n  Is it a known customer project?`);
  }
  const channel = config.connectChannel ?? 'stable';
  if (!['stable', 'beta'].includes(channel)) {
    fail(`delivery.connectChannel must be "stable" or "beta" (got "${channel}") in ${config.path}`);
  }
  return {
    channel,
    customer: config.customer,
    kind: config.kind ?? 'development',
    projects: config.projects,
    // null for a `standard` customer: an empty `projects[]` is a projectless
    // delivery, not a defect (plan-434 Phase 4).
    primary: config.projectKey,
    remote: typeof config.remote === 'string' && config.remote.trim() ? config.remote.trim() : '<remote>',
    requestyApiKey: config.requestyApiKey,
    requestyBaseUrl: config.requestyBaseUrl,
  };
}

//! Picks the win-x64 artifact from a v1 (flat) or v2 (platforms map) CONNECT channel manifest.
function extractWinEntry(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('CONNECT channel manifest is not an object.');
  const platform = manifest.platforms?.['win-x64'];
  if (platform) {
    return { version: manifest.version, build: manifest.build ?? platform.build, url: platform.url, sha256: platform.sha256 };
  }
  // v1 flat manifest is win-x64 only.
  return { version: manifest.version, build: manifest.build, url: manifest.url, sha256: manifest.sha256 };
}

//! Resolves the CONNECT pin: honours RV_CONNECT_LOCK, else builds a temp lock from the channel
//! manifest. A 404 on a non-stable channel (lane not deployed yet) falls back to stable with a
//! loud warning; only a stable failure is fatal. Exported for unit testing (fetchImpl injectable).
export async function resolveConnectLock(channel, tmpBase, fetchImpl = fetch) {
  const override = process.env.RV_CONNECT_LOCK;
  if (override) {
    const lockPath = resolve(override);
    if (!existsSync(lockPath)) fail(`RV_CONNECT_LOCK points to a missing file: ${lockPath}`);
    return { lockPath, source: 'RV_CONNECT_LOCK', channel };
  }

  // plan-343 Phase 0: ONE beta manifest path across the whole tree. This used to build
  // download/beta/connect-latest.json while connect-downloads.ts probed download/connect-beta.json —
  // both 404'd, so nobody noticed. connect-beta.json is the contract; deploy-connect writes it.
  const manifestUrlFor = (lane) =>
    `https://web.realvirtual.io/download/${lane === 'stable' ? 'connect-latest.json' : `connect-${lane}.json`}`;
  let effectiveChannel = channel;
  let manifestUrl = manifestUrlFor(channel);
  let manifest;
  try {
    let response = await fetchImpl(manifestUrl, { redirect: 'follow' });
    if (response.status === 404 && channel !== 'stable') {
      console.warn(`[deliver] WARNING: "${channel}" CONNECT channel manifest is not deployed (HTTP 404): ${manifestUrl}`);
      console.warn('[deliver] WARNING: falling back to the STABLE CONNECT channel for this delivery.');
      effectiveChannel = 'stable';
      manifestUrl = manifestUrlFor('stable');
      response = await fetchImpl(manifestUrl, { redirect: 'follow' });
    }
    if (!response.ok) fail(`CONNECT channel manifest fetch failed: HTTP ${response.status} (${manifestUrl})`);
    manifest = await response.json();
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`Could not fetch CONNECT channel manifest (${manifestUrl}): ${error.message}`);
  }

  const entry = extractWinEntry(manifest);
  if (typeof entry.version !== 'string' || !entry.version) fail(`CONNECT channel manifest has no version (${manifestUrl}).`);
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')) fail(`CONNECT channel manifest sha256 is missing or invalid (${manifestUrl}).`);

  // The stable channel manifest advertises the MUTABLE download/realvirtual-Connect.exe URL.
  // Deliveries must pin an IMMUTABLE download/versions/... URL, so reconstruct + HEAD-verify it.
  let url = entry.url;
  if (!url || !/\/versions\//.test(new URL(url).pathname)) {
    const buildSuffix = entry.build !== undefined && entry.build !== null ? `+${entry.build}` : '';
    url = `https://web.realvirtual.io/download/versions/realvirtual-Connect-${entry.version}${buildSuffix}.exe`;
    let head;
    try {
      head = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    } catch (error) {
      fail(`Could not reach immutable CONNECT version URL (${url}): ${error.message}`);
    }
    if (!head.ok) {
      fail(`Immutable CONNECT version not published (HTTP ${head.status}):\n  ${url}\n  Run /deploy-connect first to publish download/versions/realvirtual-Connect-<version>+<build>.exe.`);
    }
  }

  const lock = { channel: effectiveChannel, version: entry.version, url, sha256: entry.sha256.toLowerCase() };
  mkdirSync(tmpBase, { recursive: true });
  const lockPath = join(tmpBase, `connect-${effectiveChannel}-${entry.version}.lock.json`);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return { lockPath, source: manifestUrl, channel: effectiveChannel };
}

function printUsage() {
  console.log(`Usage: node scripts/deliver.mjs <projectKey> [--push] [--fast] [--dry-run] [--no-rag]
       node scripts/deliver.mjs --customer <name> [--push] ...

One-shot customer delivery around generate-customer-workspace.mjs.

Arguments:
  <projectKey>   e.g. mauser3dhmi. Resolved against every delivery config in
                 ../realvirtual-WebViewer-Private~/delivery/ — the file name no longer
                 has to match, because one config may carry several projects.

Flags:
  --customer     deliver every project of one customer repository instead of one key.
                 The only way to reach a "standard" customer: they carry no projects,
                 so a positional <projectKey> cannot address them. Such a delivery is
                 projectless — an empty projects/ folder, and no diagnosis package.
  --push         build + push the workspace to the customer remote (omit for a dry run)
  --dry-run      stage + build only, never push (the default when --push is absent)
  --fast         reuse the build cache when the lockfiles are unchanged
  --seed-missing create vendor files that are missing at the customer's end. Only ever
                 needed for a repository delivered before plan-700 (no baseline tag),
                 where "never delivered" and "deleted on purpose" cannot be told apart
                 and the report therefore only asks.
  --accept-new-private-files
                 confirm private source files that this customer has never received before.
                 Without it the delivery aborts and lists them by name: the manifest default
                 is "commercial", so a new file under src/ ships to everyone unless a tier
                 rule says otherwise, and this is the one place that says so out loud.
  --no-rag       deliver without the CONNECT diagnosis package (no rag.zip, no connect/ folder).
                 Neither the RAG seed index nor a <projectKey>.diagnosis.json preset is needed.

Preflight (runs before anything is built):
  - both WebViewer git trees clean (core + private)
  - a realvirtual-vX.Y.Z release tag on the core HEAD

Auto-resolved paths (override with env vars):
  RV_RAG_SEED_INDEX   overrides the seed index. Without it: the project's own
                      ../realvirtual-WebViewer-Private~/projects/<key>/rag/vector-index.json,
                      else the machine-global ${DEFAULT_SEED_INDEX}
  RV_CONNECT_LOCK     use an existing connect.lock.json instead of building one from the channel manifest
  RV_DELIVER_TMP      temp directory forced onto the build child (default ${DEFAULT_TMP})
  REQUESTY_API_KEY    forwarded to the RAG bundler (never logged)`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const customerIndex = argv.indexOf('--customer');
  const customer = customerIndex >= 0 ? argv[customerIndex + 1] : null;
  if (customerIndex >= 0 && (!customer || customer.startsWith('-'))) fail('--customer needs a name, e.g. --customer mauser');
  // -1 + 1 === 0, so without --customer this used to drop argv[0] — the project key itself, making
  // the documented `deliver.mjs <projectKey>` form fail with "Missing <projectKey>". Only skip the
  // value slot when there actually is a --customer to consume it.
  const customerValueIndex = customerIndex >= 0 ? customerIndex + 1 : -1;
  const positional = argv.filter((token, index) => !token.startsWith('-') && index !== customerValueIndex);
  if (!customer && positional.length === 0) fail('Missing <projectKey>. Try: node scripts/deliver.mjs <projectKey> --push [--fast] [--dry-run]');
  if (positional.length > 1) fail(`Only one <projectKey> is allowed, got: ${positional.join(', ')}`);
  if (customer && positional.length) fail(`Pass either <projectKey> or --customer, not both (got "${positional[0]}" and "${customer}").`);
  const requestedKey = positional[0] ?? null;
  if (requestedKey && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(requestedKey)) fail(`Invalid project key: ${requestedKey}`);

  const push = argv.includes('--push');
  const fast = argv.includes('--fast');
  const seedMissing = argv.includes('--seed-missing');
  const acceptNewPrivateFiles = argv.includes('--accept-new-private-files');
  const dryRun = !push; // never push unless explicitly asked

  const version = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8')).version;

  // ── Resolve the request to ONE customer repository. ────────────────────────────────────
  const { channel, remote, projects, primary, kind, customer: customerSlug, requestyApiKey, requestyBaseUrl } =
    resolveDelivery({ projectKey: requestedKey, customer });
  const projectKey = primary;
  // A `standard` customer receives the product with an empty `projects/` folder.
  // There is no corpus to embed and no diagnosis preset to read, so --no-rag is
  // not a choice here, it is the only shape this delivery has (plan-434 Phase 4).
  const projectless = projects.length === 0;
  const noRag = argv.includes('--no-rag') || projectless;
  console.log(`[deliver] ${projectless ? `customer=${customerSlug} (projectless)` : `project=${projectKey}`}`
    + ` mode=${push ? 'PUSH' : 'dry-run'}${fast ? ' fast' : ''}${noRag ? ' no-rag' : ''} viewer=${version}`);
  if (projectless) console.log(`[deliver] ${kind} customer: projectless delivery, no RAG`);
  if (projects.length > 1) console.log(`[deliver] repository carries ${projects.length} projects: ${projects.join(', ')}`);

  // ── Preflight: fail early, before any path resolution, network, or build. ──────────────
  assertCleanTree('realvirtual-WebViewer~ (core)', coreRoot);
  assertCleanTree('realvirtual-WebViewer-Private~ (private)', privateRoot);
  assertReleaseTag(coreRoot, version);
  // The project validator is a GATE, not a suggestion (F10 / B12). It used to
  // exist and be wired into nothing, so an invalid manifest, a secret committed
  // into a project, or a vendor glob pointing at the customer's own scenes all
  // travelled straight through to the customer. It runs here, before anything is
  // fetched, built or pushed, because that is the last moment failing is free.
  // Every project of the repository is gated, not just the one that was named:
  // they all end up in the same push.
  // A projectless delivery gates nothing here — there is no project to validate,
  // which is exactly what the count below says.
  for (const key of projects) assertValidProject(join(privateRoot, 'projects', key), `projects/${key}`);
  console.log(`[deliver] preflight ok: both trees clean, release tag present, ${projects.length} project(s) valid.`);

  // --no-rag ships a workspace without the CONNECT diagnosis package. Both inputs below exist
  // only to build that package, so neither is resolved — and neither is required — in that mode.
  let diagnosisConfig = null;
  let seedIndex = null;
  let seedIndexOrigin = null;
  if (noRag) {
    console.log('[deliver] no-rag:            no diagnosis package (seed index and diagnosis preset not required)');
  } else {
    diagnosisConfig = join(presetsDir, `${projectKey}.diagnosis.json`);
    if (!existsSync(diagnosisConfig)) {
      fail(`Diagnosis preset not found:\n  ${diagnosisConfig}\n  Expected ../realvirtual-Connect~/tools/presets/${projectKey}.diagnosis.json\n  Or deliver without the diagnosis package: --no-rag`);
    }

    // The seed index is the embedded form of THIS customer's document corpus - not shared
    // material - so it belongs next to the documents it was computed from, versioned in the
    // private repo (LFS). Resolution order:
    //   1. RV_RAG_SEED_INDEX      explicit override always wins
    //   2. projects/<key>/rag/    the customer's own index, the canonical home
    //   3. <WS>/rag-runtime/...   legacy machine-global path, kept so a project without a
    //                             committed index still delivers from the machine that built it
    const projectSeedIndex = join(privateRoot, 'projects', projectKey, 'rag', 'vector-index.json');
    let seedIndexSource;
    if (process.env.RV_RAG_SEED_INDEX) {
      seedIndex = resolve(process.env.RV_RAG_SEED_INDEX);
      seedIndexSource = 'RV_RAG_SEED_INDEX';
    } else if (existsSync(projectSeedIndex)) {
      seedIndex = projectSeedIndex;
      seedIndexSource = 'project';
    } else {
      seedIndex = resolve(DEFAULT_SEED_INDEX);
      seedIndexSource = 'machine-global (legacy)';
    }
    if (!existsSync(seedIndex)) {
      fail(`RAG seed index not found:\n  ${seedIndex}\n  Commit the project index to ${projectSeedIndex},\n  set RV_RAG_SEED_INDEX, or start CONNECT and trigger /diagnose once to build the vector index.\n  Or deliver without the diagnosis package: --no-rag`);
    }
    seedIndexOrigin = seedIndexSource;
  }

  // TMP/TEMP inherited from the shell often point to the full C: drive (Git-Bash default) and the
  // RAG step then dies with ENOSPC. Force the child temp onto E: unless RV_DELIVER_TMP overrides.
  const tmpOverride = process.env.RV_DELIVER_TMP;
  const tmpBase = resolve(tmpOverride || DEFAULT_TMP);
  mkdirSync(tmpBase, { recursive: true });
  console.log(`[deliver] temp:             ${tmpBase} (${tmpOverride ? 'RV_DELIVER_TMP' : 'forced default, override with RV_DELIVER_TMP'})`);

  const { lockPath, source, channel: effectiveChannel } = await resolveConnectLock(channel, tmpBase);

  if (!noRag) {
    console.log(`[deliver] diagnosis-config: ${diagnosisConfig}`);
    console.log(`[deliver] seed-index:       ${seedIndex} (${seedIndexOrigin})`);
  }
  console.log(`[deliver] connect-lock:     ${lockPath} (${source})`);
  console.log(`[deliver] connect-channel:  ${effectiveChannel}${effectiveChannel !== channel ? ` (requested "${channel}", fell back to stable)` : ''}`);

  // ── Spawn the generator, forwarding its exit code. ─────────────────────────────────────
  // `--project` cannot address a projectless customer — there is no key — so the
  // generator is asked for the whole customer repository instead.
  const args = projectless
    ? [generator, '--customer', customerSlug, '--connect-lock', lockPath]
    : [generator, '--project', projectKey, '--connect-lock', lockPath];
  if (seedMissing) args.push('--seed-missing');
  if (acceptNewPrivateFiles) args.push('--accept-new-private-files');
  if (noRag) args.push('--no-rag');
  else args.push('--seed-index', seedIndex, '--diagnosis-config', diagnosisConfig);
  if (push) args.push('--push');
  if (dryRun) args.push('--dry-run');
  if (fast) args.push('--fast');

  const childEnv = { ...process.env };
  // The diagnosis credentials, resolved like the three paths above: the environment wins (a one-off
  // run against another gateway), the delivery config fills in. Before this, a delivery from a
  // machine whose shell had never exported REQUESTY_API_KEY died at the RAG step, and the value was
  // recoverable only by cloning the customer's repository back — bundle-rag embeds it into the
  // delivered project-config.json, so the key was already in their git either way.
  if (!noRag) {
    if (!childEnv.REQUESTY_API_KEY && requestyApiKey) childEnv.REQUESTY_API_KEY = requestyApiKey;
    if (!childEnv.REQUESTY_BASE_URL && requestyBaseUrl) childEnv.REQUESTY_BASE_URL = requestyBaseUrl;
    // Named, never valued: the source is useful in a build log, the secret is not.
    console.log('[deliver] diagnosis key:   '
      + (process.env.REQUESTY_API_KEY ? 'REQUESTY_API_KEY (environment)'
        : requestyApiKey ? `delivery config (${requestyBaseUrl ?? 'default base URL'})`
          : 'MISSING - set REQUESTY_API_KEY or delivery.requestyApiKey'));
  }
  // C: is full on this box; ALWAYS keep the generator's mkdtemp scratch on tmpBase (E: by
  // default, RV_DELIVER_TMP override) — the shell's inherited TMP/TEMP must not win here.
  childEnv.TMP = tmpBase;
  childEnv.TEMP = tmpBase;

  try {
    execFileSync(process.execPath, args, { stdio: 'inherit', env: childEnv });
  } catch (error) {
    process.exitCode = typeof error.status === 'number' ? error.status : 1;
    return;
  }

  const changeset = readPlasticChangeset(resolve(coreRoot, '../../../..'));
  const versionTag = Number.isInteger(changeset) ? `${version}-${changeset}` : version;
  const delivered = projectless ? `customer ${customerSlug} (projectless)` : projectKey;
  if (push) console.log(`delivered ${delivered} → ${remote} (viewer ${versionTag})`);
  else console.log(`[dry-run] staged ${delivered} (viewer ${versionTag}); no remote was modified.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[deliver] ${error.message}`);
    process.exitCode = 1;
  });
}
