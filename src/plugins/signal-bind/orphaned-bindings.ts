// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * orphaned-bindings — saved signal links whose carrier object is gone
 * (plan-422 F9).
 *
 * ## Why this cannot live in the replay traverse
 *
 * `SignalBindPlugin.onModelLoaded()` restores bindings by walking the nodes of
 * the LOADED model and reading `SignalLinks` off each one. A mapping whose
 * carrier node no longer exists is, by construction, never visited there: the
 * traverse can only find what is present. The absence is exactly the thing that
 * needs reporting, so it has to be looked for from the other side — the stored
 * ops — and checked against the registry.
 *
 * ## Why it matters now
 *
 * Node bindings persist by PATH (`doc-node-paths.md`). Re-parenting a group in
 * the Unity scene — which is what plan-422 phase 6 does to the demo, moving the
 * machine and robot signal groups onto their machines — rewrites those paths,
 * and every binding a user had saved against the old ones stops resolving. With
 * no word said, that is indistinguishable from the "bindings do not survive a
 * reload" defect phase 1 just fixed, and the second report would be much harder
 * to believe.
 *
 * The ops are KEPT. Loading the previous model, or moving the objects back,
 * makes them live again — deleting them would be the only truly irreversible
 * response to a situation that is usually temporary.
 */

import type { RVExtrasOverlay } from '../../core/engine/rv-extras-overlay-store';
import type { SignalMapping } from '../layout-planner/rv-layout-store';

/** The registry surface this check needs — a path either resolves, or it does not. */
export interface NodeResolver {
  getNode(path: string): unknown;
}

/** An orphaned carrier together with what it was carrying. */
export interface OrphanedCarrier {
  /** The stored path that no longer resolves. */
  nodePath: string;
  /** The mappings on it, read straight out of the op payload. */
  mappings: SignalMapping[];
}

/**
 * Orphaned carriers WITH their payload — the same scan as
 * {@link findOrphanedBindingPaths}, keeping what it throws away.
 *
 * The payload is the entire point of reading from the op side (plan-425 F2). A
 * pathdressed op whose path is dead is never materialised onto any node, so
 * nothing downstream can ever see the `carrierSignalName` inside it. The overlay
 * is the last place that anchor is legible, and this is that read.
 */
export function findOrphanedBindingCarriers(
  overlay: Pick<RVExtrasOverlay, 'nodes'> | null | undefined,
  registry: NodeResolver | null | undefined,
): OrphanedCarrier[] {
  if (!overlay?.nodes || !registry) return [];
  const orphans: OrphanedCarrier[] = [];
  const seen = new Set<string>();
  for (const [nodePath, components] of Object.entries(overlay.nodes)) {
    const links = (components as Record<string, unknown>)?.SignalLinks as
      { Mappings?: unknown } | undefined;
    const mappings = links?.Mappings;
    if (!Array.isArray(mappings) || mappings.length === 0) continue;
    if (seen.has(nodePath)) continue;
    seen.add(nodePath);
    if (registry.getNode(nodePath)) continue;
    orphans.push({ nodePath, mappings: (mappings as SignalMapping[]).map((m) => ({ ...m })) });
  }
  return orphans;
}

/** What the name anchor needs to answer: where does this signal live now? */
export interface CarrierNameResolver {
  /** Node path currently registered for `name`, or undefined. */
  getPath(name: string): string | undefined;
  /** True when `name` is claimed by more than one live node (fail-closed). */
  isDuplicate(name: string): boolean;
}

/** A carrier that can be moved to a path the current model actually has. */
export interface CarrierMigration {
  /** The dead stored path the op sits on today. */
  from: string;
  /** Where the anchor says it belongs now. */
  to: string;
  /** The payload to re-persist, unchanged. */
  mappings: SignalMapping[];
}

/**
 * Split orphaned carriers into "the name anchor knows where this went" and
 * "still lost" (plan-425 F2).
 *
 * A migration is offered only when the anchor is unambiguous on BOTH sides: the
 * mappings agree on one `carrierSignalName`, that name resolves, and it is not
 * shared with a second live node. Anything less stays an orphan and is reported
 * the way it always was — the anchor is here to remove a class of false alarm,
 * not to start guessing where guessing was previously refused.
 *
 * A migration onto a path that is ALREADY a carrier is refused too: re-persisting
 * there would overwrite whatever that node's own mappings are — turning a
 * repair into data loss. Pass those paths as `occupied`.
 */
export function planCarrierMigrations(
  carriers: readonly OrphanedCarrier[],
  resolver: CarrierNameResolver,
  registry: NodeResolver,
  occupied: ReadonlySet<string> = new Set(),
): { migrations: CarrierMigration[]; stillOrphaned: string[] } {
  const migrations: CarrierMigration[] = [];
  const stillOrphaned: string[] = [];
  const claimed = new Set<string>();
  for (const carrier of carriers) {
    const names = new Set(carrier.mappings
      .map((m) => m.carrierSignalName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0));
    const name = names.size === 1 ? [...names][0] : undefined;
    const to = name && !resolver.isDuplicate(name) ? resolver.getPath(name) : undefined;
    // `to === from` cannot happen (from did not resolve), but a path that two
    // dead carriers both point at would have the second silently clobber the
    // first — so a destination is taken at most once per scan.
    if (!to || to === carrier.nodePath || claimed.has(to) || occupied.has(to)
      || !registry.getNode(to)) {
      stillOrphaned.push(carrier.nodePath);
      continue;
    }
    claimed.add(to);
    migrations.push({ from: carrier.nodePath, to, mappings: carrier.mappings });
  }
  return { migrations, stillOrphaned };
}

/**
 * Carrier paths in `overlay` that hold `SignalLinks.Mappings` and do not
 * resolve, in overlay order and without duplicates.
 *
 * Pure and synchronous: the data source is the materialised overlay — the very
 * structure `splitOverlay()` iterates when baking — so a mapping that would be
 * WRITTEN to a node is exactly a mapping that is CHECKED here.
 *
 * A carrier with an empty mapping list is not an orphan: there is nothing on it
 * to lose, and reporting it would turn "I unlinked everything" into a warning.
 */
export function findOrphanedBindingPaths(
  overlay: Pick<RVExtrasOverlay, 'nodes'> | null | undefined,
  registry: NodeResolver | null | undefined,
): string[] {
  if (!overlay?.nodes || !registry) return [];
  const orphans: string[] = [];
  const seen = new Set<string>();
  for (const [nodePath, components] of Object.entries(overlay.nodes)) {
    const links = (components as Record<string, unknown>)?.SignalLinks as
      { Mappings?: unknown } | undefined;
    const mappings = links?.Mappings;
    if (!Array.isArray(mappings) || mappings.length === 0) continue;
    if (seen.has(nodePath)) continue;
    seen.add(nodePath);
    if (registry.getNode(nodePath)) continue;
    orphans.push(nodePath);
  }
  return orphans;
}
