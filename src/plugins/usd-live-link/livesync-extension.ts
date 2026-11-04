// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * livesync-extension — the Isaac Sim extension as the viewer sees it (plan-637 Phase 6):
 * where to download it, which version this viewer needs, and what the `ready` ack of a
 * connected extension means for the sync.
 *
 * Only the lazily loaded USD menu and live-link session import this module, so the build
 * define `__RV_LIVESYNC_EXT__` (set by `scripts/_rv-livesync-extension.mjs`) never reaches
 * the entry chunk.
 *
 * Handshake rules (`ready` ack: `{type:"ready", extVersion, protocol}`):
 * - `protocol` other than {@link LIVESYNC_PROTOCOL_VERSION} → incompatible: no mount, clear error.
 * - `protocol` missing (extension before 0.2.0) counts as protocol 1.
 * - `extVersion` missing or below {@link MIN_EXTENSION_VERSION} → outdated: the sync runs anyway,
 *   the menu and the pill tooltip point to the download.
 */

import { LIVESYNC_PROTOCOL_VERSION, type LiveSyncAck } from './livesync-protocol';

/** Oldest extension this viewer works with without a hint (`extension.toml` version). */
export const MIN_EXTENSION_VERSION = '0.2.0';

/** The download this build ships, or null. */
export interface LivesyncExtensionDownload {
  version: string;
  /** URL relative to the page (deploy base + `downloads/…zip`). */
  url: string;
}

/** The extension download of this build (null when the build has none). */
export function livesyncExtensionDownload(): LivesyncExtensionDownload | null {
  const info = typeof __RV_LIVESYNC_EXT__ !== 'undefined' ? __RV_LIVESYNC_EXT__ : null;
  if (!info) return null;
  return { version: info.version, url: `${import.meta.env.BASE_URL}${info.path}` };
}

function parts(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare two `major.minor.patch` versions (pre-release / build suffixes ignored).
 * Negative when `a < b`, 0 when equal, positive when `a > b`; an unparsable side counts as lowest.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** What a `ready` ack means for the sync. */
export type ExtensionCheck =
  | { kind: 'ok'; version: string }
  | { kind: 'outdated'; version: string | null; notice: string }
  | { kind: 'incompatible'; protocol: number; message: string };

/** The version to point the user to: the shipped download, else the minimum. */
function targetVersion(download: LivesyncExtensionDownload | null): string {
  return download && compareVersions(download.version, MIN_EXTENSION_VERSION) >= 0 ? download.version : MIN_EXTENSION_VERSION;
}

/** Evaluate the `ready` ack of the extension. */
export function checkExtension(
  ack: LiveSyncAck,
  download: LivesyncExtensionDownload | null = livesyncExtensionDownload(),
): ExtensionCheck {
  const target = targetVersion(download);
  if (ack.protocol !== undefined && ack.protocol !== LIVESYNC_PROTOCOL_VERSION) {
    return {
      kind: 'incompatible',
      protocol: ack.protocol,
      message: `The Isaac Sim extension uses live sync protocol ${ack.protocol}, this viewer protocol ${LIVESYNC_PROTOCOL_VERSION}. `
        + `Install the extension v${target} from the USD menu.`,
    };
  }
  const version = ack.extVersion ?? null;
  if (version !== null && compareVersions(version, MIN_EXTENSION_VERSION) >= 0) return { kind: 'ok', version };
  return {
    kind: 'outdated',
    version,
    notice: `Isaac Sim extension outdated (${version ? `v${version}` : 'version unknown'}) — download v${target}`,
  };
}
