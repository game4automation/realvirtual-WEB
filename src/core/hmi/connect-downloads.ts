// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Canonical stable CONNECT installer published by the deploy-connect workflow. */
export const CONNECT_STABLE_DOWNLOAD_URL =
  'https://web.realvirtual.io/download/realvirtual-Connect.exe';

/** Canonical stable Linux x64 CONNECT bundle published by the deploy-connect workflow. */
export const CONNECT_STABLE_LINUX_DOWNLOAD_URL =
  'https://web.realvirtual.io/download/realvirtual-Connect-linux-x64.tar.gz';

/** Backward-compatible v2 manifest containing immutable hashes for all published platforms. */
export const CONNECT_STABLE_MANIFEST_URL =
  'https://web.realvirtual.io/download/connect-latest.json';

/**
 * Beta-channel manifest. Optional — the deploy-connect workflow only writes it when a beta
 * build is published. The panel probes this URL and shows the beta download **only if it
 * resolves** (see {@link ConnectDownloadInfo.beta}). Same manifest shape as the stable one.
 */
export const CONNECT_BETA_MANIFEST_URL =
  'https://web.realvirtual.io/download/connect-beta.json';

/**
 * Static beta installer URL. Kept `null` because no fixed beta path is published yet; the beta
 * download link is instead taken from {@link CONNECT_BETA_MANIFEST_URL}'s `url` field at runtime.
 * Preserved as an export for backward compatibility with existing imports/tests.
 */
export const CONNECT_BETA_DOWNLOAD_URL: string | null = null;

// ── Release manifest (connect-latest.json / connect-beta.json) ─────────────

/** Shape of the CONNECT release manifest written by the deploy-connect workflow. */
export interface ConnectReleaseManifest {
  version: string;
  build?: number;
  buildDate?: string;
  url: string;
  sha256?: string;
}

/** Resolved download affordance for one channel — url is always present, version enriches it. */
export interface ConnectChannelInfo {
  url: string;
  version: string | null;
  build: number | null;
  buildDate: string | null;
}

export interface ConnectDownloadInfo {
  /** Stable channel — url is always the fixed installer path; version fills in when the
   *  manifest is reachable (same-origin, or once CORS is enabled on the download path). */
  stable: ConnectChannelInfo;
  /** Beta channel — present ONLY when connect-beta.json resolves to a real build. */
  beta: ConnectChannelInfo | null;
  /** True once both manifest probes have settled (so callers can avoid a version flash). */
  loaded: boolean;
}

function initialInfo(): ConnectDownloadInfo {
  return {
    stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: null, build: null, buildDate: null },
    beta: null,
    loaded: false,
  };
}

let _info: ConnectDownloadInfo = initialInfo();
let _loadStarted = false;
const _listeners = new Set<() => void>();

function _emit(): void {
  for (const l of _listeners) l();
}

function _channelFromManifest(m: ConnectReleaseManifest, fallbackUrl: string): ConnectChannelInfo {
  return {
    url: typeof m.url === 'string' && m.url ? m.url : fallbackUrl,
    version: typeof m.version === 'string' && m.version ? m.version : null,
    build: typeof m.build === 'number' ? m.build : null,
    buildDate: typeof m.buildDate === 'string' && m.buildDate ? m.buildDate : null,
  };
}

async function _probe(url: string): Promise<ConnectReleaseManifest | null> {
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-cache' });
    if (!res.ok) return null;
    const json = (await res.json()) as ConnectReleaseManifest;
    if (!json || typeof json !== 'object') return null;
    return json;
  } catch {
    // Network error / CORS block / offline — degrade silently to the static button.
    return null;
  }
}

/**
 * Kick off a one-time probe of the stable and beta manifests. Safe to call repeatedly; the
 * network fetch runs only once per session. Failures are swallowed — the stable download stays
 * available with its fixed URL, just without a version label.
 */
export function ensureConnectDownloadsLoaded(): void {
  if (_loadStarted) return;
  _loadStarted = true;

  // Under vitest, skip the real network probe: versions stay null so the static button text is
  // deterministic (a background fetch could otherwise resolve mid-suite and mutate shared state).
  if (import.meta.env?.MODE === 'test') return;

  void (async () => {
    const [stableManifest, betaManifest] = await Promise.all([
      _probe(CONNECT_STABLE_MANIFEST_URL),
      _probe(CONNECT_BETA_MANIFEST_URL),
    ]);
    _info = {
      stable: stableManifest
        ? _channelFromManifest(stableManifest, CONNECT_STABLE_DOWNLOAD_URL)
        : { url: CONNECT_STABLE_DOWNLOAD_URL, version: null, build: null, buildDate: null },
      beta: betaManifest && typeof betaManifest.url === 'string' && betaManifest.url
        ? _channelFromManifest(betaManifest, betaManifest.url)
        : null,
      loaded: true,
    };
    _emit();
  })();
}

export function subscribeConnectDownloads(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getConnectDownloadsSnapshot(): ConnectDownloadInfo {
  return _info;
}

/** Test-only: reset the module store so a fresh probe can run. */
export function __resetConnectDownloadsForTest(): void {
  _info = initialInfo();
  _loadStarted = false;
  _listeners.clear();
}

/** Test-only: inject a resolved snapshot (the network probe is skipped under vitest). */
export function __setConnectDownloadsForTest(info: ConnectDownloadInfo): void {
  _info = info;
  _loadStarted = true;
  _emit();
}
