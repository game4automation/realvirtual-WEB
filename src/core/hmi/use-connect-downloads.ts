// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore, useEffect } from 'react';
import {
  ensureConnectDownloadsLoaded,
  subscribeConnectDownloads,
  getConnectDownloadsSnapshot,
  type ConnectDownloadInfo,
} from './connect-downloads';

/**
 * React hook exposing the resolved CONNECT download channels (stable + optional beta) with
 * version labels. Triggers the one-time manifest probe on first mount; degrades silently to
 * the static stable URL when the manifest is unreachable (offline / cross-origin without CORS).
 */
export function useConnectDownloads(): ConnectDownloadInfo {
  const info = useSyncExternalStore(subscribeConnectDownloads, getConnectDownloadsSnapshot);
  useEffect(() => { ensureConnectDownloadsLoaded(); }, []);
  return info;
}
