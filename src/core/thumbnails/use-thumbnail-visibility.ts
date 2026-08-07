// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Visibility scheduling for library previews (plan-372 §2.8).
 *
 * The planner used to render a preview for *every* catalog entry the moment a
 * library appeared. This flips that around: a card asks for its picture when it
 * scrolls into view and withdraws the request when it leaves. On a 500-asset
 * library the difference is 500 GLB decodes versus the dozen actually on
 * screen.
 *
 * ## One observer for all cards
 *
 * Every card creating its own `IntersectionObserver` would allocate hundreds of
 * observers and hundreds of callbacks per scroll. A single module-scope
 * observer is shared by every card in the document; cards register and
 * unregister their element. `rootMargin` gives a prefetch band so a preview is
 * usually ready by the time the card is actually readable.
 *
 * ## Cleanup is mandatory
 *
 * React 19 StrictMode mounts effects twice in development. Every registration
 * therefore returns its own unregister, and the effect must call it — otherwise
 * the second mount leaks the first element into the observer forever.
 */

import { useEffect, useRef, useState } from 'react';

/** Prefetch band: start work slightly before the card is on screen. */
const ROOT_MARGIN = '300px';

type VisibilityListener = (visible: boolean) => void;

let _observer: IntersectionObserver | null = null;
const _listeners = new WeakMap<Element, VisibilityListener>();

function ensureObserver(): IntersectionObserver | null {
  if (_observer) return _observer;
  // jsdom / old Safari: no IntersectionObserver. Callers fall back to
  // "always visible", which is the pre-plan-372 behaviour and still correct,
  // just less lazy.
  if (typeof IntersectionObserver === 'undefined') return null;
  _observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        _listeners.get(entry.target)?.(entry.isIntersecting);
      }
    },
    { rootMargin: ROOT_MARGIN },
  );
  return _observer;
}

/**
 * Observe `element` and report whether it is within the prefetch band.
 * Returns an unregister function; callers must invoke it on unmount.
 */
export function observeVisibility(element: Element, listener: VisibilityListener): () => void {
  const observer = ensureObserver();
  if (!observer) {
    // No observer available — treat as visible so previews still appear.
    listener(true);
    return () => { /* nothing registered */ };
  }
  _listeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    _listeners.delete(element);
  };
}

/**
 * React binding: attach the returned ref to a card and read `visible`.
 *
 * ```tsx
 * const { ref, visible } = useThumbnailVisibility();
 * useEffect(() => { if (visible) void service.enqueue(key, load); }, [visible]);
 * return <div ref={ref} />;
 * ```
 */
export function useThumbnailVisibility<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  visible: boolean;
} {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Cleanup is not optional here — see the StrictMode note in the header.
    return observeVisibility(el, setVisible);
  }, []);

  return { ref, visible };
}

/** Test seam: drop the shared observer so a suite can start from a clean slate. */
export function resetThumbnailVisibilityForTests(): void {
  _observer?.disconnect();
  _observer = null;
}
