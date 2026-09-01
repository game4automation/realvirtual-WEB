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
 * ## What the demo IS, since plan-726
 *
 * A PROJECT, not a GLB. The CONNECT bundle ships the same `project.json` the
 * hosted demo does, and starting the demo opens the project and then its start
 * document — so the community download shows the same thing a visitor to
 * web.realvirtual.io sees, project identity included, rather than a bare model
 * that happens to be the same file.
 *
 * That single path still matters, and now for a second reason. It used to be
 * "`SceneStore.openBuiltin` would never enter `loading`, so
 * `completeConnectEmbedDemoLoad()` would be ignored and the gate shell would
 * stay draped over the loaded model". `openDocument()` has exactly the same
 * property — it goes through `viewer.loadScene()`, not through
 * `loadModelWithProgress()`, so the completion `main.ts` raises for the latter
 * never fires here either. The difference is that this file now DRIVES the
 * state machine itself: `begin` before the open, `complete` or `fail` after it,
 * on every path out. Nothing downstream is relied upon to do it.
 */

import {
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
  failConnectEmbedDemoLoad,
  resetConnectEmbedDemo,
} from './connect-embed-store';
import { getProjectStore } from '../../core/project/project-store';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import { findStartDocument } from '../../core/project/rv-project-documents';
import { projectStartDocument } from '../../core/project/rv-project-open';
import { projectAssetUrl } from '../../core/project/rv-project-asset-source';

/** The slice of the viewer the demo actions need — keeps them trivially testable. */
export interface ConnectEmbedActionViewer {
  clearModel?: () => void;
  currentModelUrl?: string | null;
}

/**
 * How the demo is opened. Injected so the gate can be tested without a project
 * store, an OPFS backend and a WebGL context — the same reason the viewer above
 * is a slice rather than an `RVViewer`.
 */
export interface ConnectEmbedDemoOpener {
  /** Make the bundled demo project the active one. False when it will not open. */
  openDemoProject(): Promise<boolean>;
  /** Open one document of the now-active project by id. */
  openDocument(documentId: string, name?: string): Promise<void>;
  /** The active project's start document, or null when it names none. */
  startDocument(): { id: string; name: string; path: string } | null;
}

/**
 * The production opener: the real project store and the real scene store.
 *
 * Built per call rather than held in a module constant because both singletons
 * are created during boot — a constant evaluated at import time would capture
 * whatever existed before `initSceneStore()` ran.
 */
function defaultOpener(): ConnectEmbedDemoOpener {
  return {
    openDemoProject: () => getProjectStore().openDemoProject(),
    openDocument: async (documentId, name) => {
      const scenes = getSceneStore();
      if (!scenes) throw new Error('The scene store is not ready.');
      // `updateUrl: false`: the embed has no address bar the user can see or
      // share, and writing `?doc=` into the CONNECT shell's URL would only
      // change what a reload of that shell resolves to.
      await scenes.openDocument(documentId, {
        ...(name ? { name } : {}),
        updateUrl: false,
      });
    },
    startDocument: () => {
      const project = getProjectStore().getProject();
      const doc = findStartDocument(project, projectStartDocument(project));
      return doc ? { id: doc.id, name: doc.name, path: doc.path } : null;
    },
  };
}

/** URL of the demo document inside the CONNECT bundle, or null when it has none. */
export function connectEmbedDemoUrl(
  opener: ConnectEmbedDemoOpener = defaultOpener(),
): string | null {
  const doc = opener.startDocument();
  return doc ? projectAssetUrl(doc.path) : null;
}

/**
 * Start the embedded demo through the gate state machine.
 * No-op for a re-entrant click or outside a connect-embed deployment.
 */
export async function startConnectEmbedDemo(
  _viewer: ConnectEmbedActionViewer,
  opener: ConnectEmbedDemoOpener = defaultOpener(),
): Promise<void> {
  if (!beginConnectEmbedDemoLoad()) return;

  try {
    // The project first: `startDocument()` reads the ACTIVE project's manifest,
    // so asking before the open would answer about whatever the boot left open.
    if (!await opener.openDemoProject()) {
      failConnectEmbedDemoLoad(
        'The demo project could not be opened. Reload realvirtual CONNECT and try again.',
      );
      return;
    }
    const doc = opener.startDocument();
    if (!doc) {
      // The bundle's `project.json` is missing, unreadable or names no start
      // document. Said out loud rather than left as an empty viewport behind a
      // dismissed gate — this is a packaging fault, and the person seeing it is
      // the one who can report it.
      failConnectEmbedDemoLoad(
        'The demo project names no start document. This CONNECT build is incomplete.',
      );
      return;
    }
    await opener.openDocument(doc.id, doc.name);
    completeConnectEmbedDemoLoad();
  } catch (e) {
    failConnectEmbedDemoLoad(e instanceof Error ? e.message : String(e));
  }
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
 * `state === 'demo-running'` alone proves only that the gate was passed, so the
 * loaded URL stays the evidence of identity. What it is compared against moved
 * with the demo itself: the start document's path out of the manifest, rather
 * than a filename constant this file used to own.
 */
export function isConnectEmbedDemoLoaded(
  viewer: ConnectEmbedActionViewer,
  opener: ConnectEmbedDemoOpener = defaultOpener(),
): boolean {
  const url = viewer.currentModelUrl;
  if (!url) return false;
  const doc = opener.startDocument();
  if (!doc) return false;
  const loaded = url.split('?')[0]!;
  const file = doc.path.split('/').filter(Boolean).pop() ?? doc.path;
  return loaded === projectAssetUrl(doc.path)
    || loaded === doc.path
    || loaded.endsWith(`/${file}`)
    || loaded === file;
}
