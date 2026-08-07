// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * help-topic-registry — plugin contributions to the context-sensitive help
 * (plan-370).
 *
 * INTERNAL, NOT A GUARANTEED API. The shape may change without notice until
 * real plugin use cases have shaped it.
 *
 * The CORE help context (open window, active workspace mode) is DERIVED at call
 * time from the managers that already hold it — it is deliberately not mirrored
 * here. This registry exists solely for what cannot be derived: a plugin that
 * wants its own documentation page while its UI is in charge.
 *
 * There is NO priority parameter. Every plugin contribution sits on the fixed
 * rank 40 (above panel 30 and mode 20). Letting the caller pass a number meant
 * a contribution could silently rank below the window it was supposed to
 * describe.
 *
 * Ordering: registration order decides among equal-rank contributions, and
 * `Map.set()` does NOT move an existing key to the end — re-registering the
 * same `sourceId` keeps its original position. Unregister and register again to
 * move it.
 *
 * Follows the unregister-function pattern of `hierarchy-header-registry.ts`.
 */

import type { HelpTopic } from './help-topics';

interface RegistryEntry {
  readonly topic: HelpTopic;
  /** Monotonic id of THIS registration — guards against stale disposers. */
  readonly generation: number;
}

const _entries = new Map<string, RegistryEntry>();
const _listeners = new Set<() => void>();
let _generation = 0;
let _version = 0;

/** Content equality — slug plus anchor, not object identity. */
function sameTopic(a: HelpTopic | undefined, b: HelpTopic | undefined): boolean {
  if (!a || !b) return a === b;
  return a.slug === b.slug && (a.anchor ?? undefined) === (b.anchor ?? undefined);
}

function bump(): void {
  _version++;
  for (const fn of _listeners) fn();
}

/**
 * Contribute a help topic for as long as the plugin owns the context.
 * Returns an unregister function — call it from the plugin's `dispose()`.
 *
 * Notifies subscribers only when the winning contribution changes IN CONTENT,
 * so a plugin that allocates a fresh `{slug}` object on every call cannot start
 * a notification cascade.
 */
export function registerHelpTopic(sourceId: string, topic: HelpTopic): () => void {
  const generation = ++_generation;
  const before = readPluginTopic();
  _entries.set(sourceId, {
    topic: topic.anchor === undefined ? { slug: topic.slug } : { slug: topic.slug, anchor: topic.anchor },
    generation,
  });
  if (!sameTopic(before ?? undefined, readPluginTopic() ?? undefined)) bump();

  return () => {
    const current = _entries.get(sourceId);
    // A disposer from a superseded registration must not remove the newer one.
    if (!current || current.generation !== generation) return;
    const previousWinner = readPluginTopic();
    _entries.delete(sourceId);
    if (!sameTopic(previousWinner ?? undefined, readPluginTopic() ?? undefined)) bump();
  };
}

/** The winning plugin contribution (first registered), or null. */
export function readPluginTopic(): HelpTopic | null {
  for (const entry of _entries.values()) return entry.topic;
  return null;
}

/** useSyncExternalStore plumbing — subscribe. */
export function subscribeHelpTopics(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * useSyncExternalStore plumbing — snapshot.
 *
 * Returns a VERSION NUMBER, not the topic object: `getSnapshot` must be
 * referentially stable between notifications, and a topic object is not.
 * Read the value itself with {@link readPluginTopic}.
 */
export function getHelpTopicsSnapshot(): number {
  return _version;
}

/** @internal Reset all contributions for isolated tests. */
export function _resetHelpTopicRegistryForTests(): void {
  _entries.clear();
  _generation = 0;
  _version = 0;
  _listeners.clear();
}
