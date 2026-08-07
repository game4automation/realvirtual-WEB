// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Cloud extension contract for the Layout Planner.
 *
 * The public AGPL planner is cloud-agnostic. A private extension (Unity
 * Asset Manager) plugs in via `LayoutPlannerPlugin.setExtension()` and
 * supplies a structural `cloudStore` plus an optional library-tab
 * component. When the extension is absent (public-only build), all
 * cloud UI is hidden and the restore path skips cloud-asset resolution.
 *
 * Type-only module — no runtime side-effects. Imported by `index.ts`
 * and re-exported from there for backwards compatibility with external
 * consumers (private Unity Asset Manager extension).
 */

import type { ComponentType } from 'react';
import type { LayoutPlannerPlugin } from './index';

/** Minimal structural shape consumed by the public planner. The private
 *  UnityCloudStore implements this contract; public code never imports it. */
export interface LayoutPlannerCloudConnConfig {
  projectId: string;
  keyId: string;
  secretKey: string;
}

export interface LayoutPlannerCloudConn {
  id: string;
  label: string;
  config: LayoutPlannerCloudConnConfig;
}

export interface LayoutPlannerCloudConnState {
  conn: LayoutPlannerCloudConn;
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  error?: string | null;
  adapter?: unknown;
  assets?: Array<{ id: string; assetVersion: string }>;
}

export interface LayoutPlannerCloudStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): {
    connections: LayoutPlannerCloudConnState[];
    activeConnectionId: string | null;
  };
  addConnection(label: string, config: LayoutPlannerCloudConnConfig): string;
  updateConnection(id: string, label: string, config: LayoutPlannerCloudConnConfig): void;
  removeConnection(id: string): void;
  downloadGlb(connId: string, assetId: string, version: string): Promise<string>;
}

export interface LayoutPlannerCloudTabProps {
  plugin: LayoutPlannerPlugin;
  cloudStore: LayoutPlannerCloudStore;
  connectionId: string | null;
}

export interface LayoutPlannerExtension {
  /** Optional cloud-store for asset-manager integration. */
  cloudStore?: LayoutPlannerCloudStore;
  /** Optional React component rendered as additional library tab. */
  cloudTabComponent?: ComponentType<LayoutPlannerCloudTabProps>;
}
