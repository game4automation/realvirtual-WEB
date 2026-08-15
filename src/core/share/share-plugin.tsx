// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SharePlugin — mounts the shared-link info card (plan-386 §2.10).
 *
 * ## Why the `'overlay'` slot
 *
 * The two analysis agents disagreed here and the plan settled it: the
 * alternative was the hierarchy-header registry, which was mode-keyed and
 * single-component, so putting the card there would have *displaced* whatever
 * header the mode already showed. `'overlay'` composes instead of replacing.
 * (That registry is gone — plan-709 §2.1.2 replaced it with one DocumentCard
 * mounted directly — which leaves `'overlay'` as the only right answer.)
 *
 * ## Registering it is a step of its own
 *
 * R13 is the failure this file is shaped around: a plugin that is written,
 * reviewed and never passed to `.use(...)` looks finished and shows nothing.
 * The registration in `main.ts` is therefore an explicit roadmap item with its
 * own test, and `registerSharePlugin()` exists so that one call site is a named
 * function rather than a line that can silently go missing in a merge.
 */

import { useSyncExternalStore, useCallback, useState } from 'react';
import type { RVViewerPlugin } from '../rv-plugin';
import type { RVViewer } from '../rv-viewer';
import type { UISlotEntry } from '../rv-ui-plugin';
import { SharedGlbInfoCard } from './SharedGlbInfoCard';
import {
  subscribeSharedGlb,
  getSharedGlbSnapshot,
  clearSharedGlb,
  failSharedGlb,
} from './rv-share-store';
import { downloadSharedGlb } from './rv-share-fetch';
import { escalateSharedGlb, type PluginProbe } from './rv-share-escalate';
import {
  addSharedAssetBookmark,
  hasSharedAssetBookmark,
  listSharedAssetBookmarks,
  publishSharedBookmarks,
  subscribeSharedBookmarks,
  type BookmarkCatalogHost,
} from './shared-asset-bookmarks';

/**
 * Where the bookmark tab is installed.
 *
 * Injected rather than imported so this plugin does not pull the library store
 * into the consumer path — a visitor who never clicks "add to my library" pays
 * for nothing. `main.ts` supplies the real store.
 */
let bookmarkHost: BookmarkCatalogHost | null = null;

/**
 * The viewer, captured at `init`, so the escalation can ask whether the Layout
 * Planner exists **before** it replaces the workspace. `applyOp` swallows a
 * failing executor by design, so asking afterwards is too late.
 */
let pluginProbe: PluginProbe | null = null;

export function setSharedBookmarkHost(host: BookmarkCatalogHost | null): () => void {
  const previous = bookmarkHost;
  bookmarkHost = host;
  // Publish only when there is something to show. `addCatalogDirect` makes the
  // first catalogue it is given the active tab, so an unconditional call would
  // greet every visitor with an empty "Shared with me" as their default view.
  if (host && listSharedAssetBookmarks().length > 0) publishSharedBookmarks(host);
  return () => { bookmarkHost = previous; };
}

/** Slot host: reads the store and renders nothing at all when there is no share. */
export function SharedGlbInfoCardHost() {
  const snap = useSyncExternalStore(subscribeSharedGlb, getSharedGlbSnapshot, getSharedGlbSnapshot);
  const bookmarks = useSyncExternalStore(subscribeSharedBookmarks, bookmarkVersion, bookmarkVersion);
  const [escalating, setEscalating] = useState(false);

  const onDownload = useCallback(() => {
    const { payload, info } = getSharedGlbSnapshot();
    if (!payload || !info) return;
    downloadSharedGlb(payload, info.name);
  }, []);

  const onOpenInApp = useCallback(async () => {
    const { info } = getSharedGlbSnapshot();
    if (!info) return;
    setEscalating(true);
    try {
      await escalateSharedGlb(info, { viewer: pluginProbe });
    } catch (e) {
      // The card is already the visitor's error surface — reuse it rather than
      // inventing a second one he might not be looking at.
      failSharedGlb(e instanceof Error ? e.message : String(e));
    } finally {
      setEscalating(false);
    }
  }, []);

  const onAddToLibrary = useCallback(() => {
    const { info } = getSharedGlbSnapshot();
    if (!info) return;
    addSharedAssetBookmark(info);
    if (bookmarkHost) publishSharedBookmarks(bookmarkHost);
  }, []);

  if (!snap.info && !snap.error && !snap.loading) return null;

  return (
    <SharedGlbInfoCard
      info={snap.info}
      error={snap.error}
      loading={snap.loading || escalating}
      // The button is hidden — not disabled — when the provider switched
      // downloads off (F14): an inert button invites a support question about
      // why it does nothing.
      onDownload={snap.info && snap.payload && snap.info.downloadAllowed ? onDownload : undefined}
      onOpenInApp={snap.info ? () => void onOpenInApp() : undefined}
      onAddToLibrary={snap.info ? onAddToLibrary : undefined}
      // `bookmarks` is read only to make this component re-render when the
      // list changes; the value itself is a revision counter.
      bookmarked={snap.info ? hasSharedAssetBookmark(snap.info.url) && bookmarks >= 0 : false}
      onDismiss={clearSharedGlb}
    />
  );
}

/**
 * `useSyncExternalStore` needs a stable, comparable snapshot; the bookmark list
 * is rebuilt on every read, so a counter is what makes "did it change" cheap
 * and correct. Bumped by the subscription callback below.
 */
let bookmarkRevision = 0;
subscribeSharedBookmarks(() => { bookmarkRevision++; });
function bookmarkVersion(): number { return bookmarkRevision; }

export class SharePlugin implements RVViewerPlugin {
  readonly id = 'share';
  readonly order = 70;

  init(viewer: RVViewer): void {
    // Narrowed to `PluginProbe` on the way out: the escalation asks one
    // question of the viewer, and a wider type there would invite a second.
    pluginProbe = viewer as unknown as PluginProbe;
  }

  readonly slots: UISlotEntry[] = [
    // No `modes` and no visibility rule: a visitor must be able to see where a
    // foreign model came from in every mode he can reach, including after an
    // escalation into the full app.
    { slot: 'overlay', component: SharedGlbInfoCardHost, order: 95 },
  ];
}

/** The single, named registration call site (see R13 above). */
export function registerSharePlugin(viewer: { use: (p: RVViewerPlugin, group?: string) => unknown }): void {
  viewer.use(new SharePlugin(), 'core');
}
