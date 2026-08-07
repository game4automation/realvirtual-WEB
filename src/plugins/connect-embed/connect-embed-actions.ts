// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-embed-actions.ts — the two things a user can do to the embedded demo:
 * start it and close it.
 *
 * They live next to the store rather than inside it because the store is pure
 * state and knows nothing about a viewer (`connect-embed-store.ts`), and they
 * live here rather than inside a component because BOTH the gate's "Start the
 * demo" button and the model row in the panel must go through the same path.
 *
 * That single path matters: opening the demo through `SceneStore.openBuiltin`
 * instead would never enter `loading`, so `completeConnectEmbedDemoLoad()` — which
 * only accepts a transition out of `loading` — would be ignored and the gate shell
 * would stay draped over the loaded model. It would also persist a scene draft to
 * localStorage, which the embed context deliberately does not do.
 */

import {
  CONNECT_EMBED_DEMO_MODEL,
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
  failConnectEmbedDemoLoad,
  resetConnectEmbedDemo,
} from './connect-embed-store';

/** The slice of the viewer the demo actions need — keeps them trivially testable. */
export interface ConnectEmbedActionViewer {
  loadModelWithProgress?:
    | ((url: string, options?: never) => Promise<{ ok: true } | { ok: false; error: string }>)
    | null;
  clearModel?: () => void;
  currentModelUrl?: string | null;
}

/** URL of the demo GLB shipped inside the CONNECT bundle. */
export function connectEmbedDemoUrl(): string {
  return `${import.meta.env.BASE_URL}models/${CONNECT_EMBED_DEMO_MODEL}`;
}

/**
 * Start the embedded demo through the gate state machine.
 * No-op for a re-entrant click or outside a connect-embed deployment.
 */
export async function startConnectEmbedDemo(viewer: ConnectEmbedActionViewer): Promise<void> {
  if (!beginConnectEmbedDemoLoad()) return;

  const loader = viewer.loadModelWithProgress;
  if (!loader) {
    failConnectEmbedDemoLoad('The demo loader is not available. Reload realvirtual CONNECT and try again.');
    return;
  }

  const result = await loader(connectEmbedDemoUrl());
  if (result.ok) completeConnectEmbedDemoLoad();
  else failConnectEmbedDemoLoad(result.error);
}

/**
 * Close the demo and return to the gated empty state.
 *
 * Deliberately does NOT force the CONNECT panel open: the user closed the scene
 * from the model panel, so that panel stays where it is and the "Start the demo"
 * card reappears behind it (plan-373 F9).
 */
export function closeConnectEmbedDemo(viewer: ConnectEmbedActionViewer): void {
  viewer.clearModel?.();
  resetConnectEmbedDemo();
}

/**
 * True when the running demo really is the model in the viewport.
 *
 * `state === 'demo-running'` alone proves only that the gate was passed, and the
 * embed path never calls `markGlbActive()` (that would write the very draft the
 * embed avoids), so the scene store has no active built-in to compare against.
 * The loaded URL is the only honest evidence of identity.
 */
export function isConnectEmbedDemoLoaded(viewer: ConnectEmbedActionViewer): boolean {
  const url = viewer.currentModelUrl;
  if (!url) return false;
  return url.split('?')[0].endsWith(`/${CONNECT_EMBED_DEMO_MODEL}`) || url.split('?')[0] === CONNECT_EMBED_DEMO_MODEL;
}
