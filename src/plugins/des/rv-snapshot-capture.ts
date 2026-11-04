// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { createCaptureSession, type SnapshotJson } from './rv-snapshot-contract';
import type { SnapshotPart, SnapshotRegistry } from './rv-snapshot-registry';

export interface DetachedCapture {
  [key: string]: SnapshotJson | SnapshotPart[];
  parts: SnapshotPart[];
}

/** Synchronous checkpoint boundary, including envelope metadata. The shared session
 * rejects aliases across extra and participants as well as between participants.
 */
export function captureDetached(
  registry: SnapshotRegistry, extra: Record<string, unknown> = {},
): DetachedCapture {
  const session = createCaptureSession();
  const metadata = session.capture('snapshot.extra', extra) as Record<string, SnapshotJson>;
  return { ...metadata, parts: registry.captureAll(session) };
}
