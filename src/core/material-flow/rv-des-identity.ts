// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-identity.ts — the DES component id (plan-2059 Phase 1).
 *
 * ONE id per DES component instance, built on the plan-769 node identity — no
 * second id system:
 *
 *     desComponentId = <full node address> '@' <component type>
 *                    = `${occurrence}#${nodeId}@${type}`   (e.g. `p1/b2#9f..@Conveyor`)
 *
 * - The address is `NodeRegistry.getAddressForNode(node)`: the ABSOLUTE
 *   `<occurrence>#<NodeId>` over every placement level, stable over reload
 *   (authored NodeId, else the UUIDv5 seed of the authored path). Two
 *   placements of the same asset differ by their occurrence chain; a copied
 *   placement gets a fresh reference NodeId and therefore fresh ids.
 * - The slot is the component TYPE: `resolveNodeMaterialFlows` dedupes name-
 *   and payload-discovery by type, so a node carries at most one definition
 *   per type, whatever found it and in whatever order (Thomas 2026-11-02).
 * - No name / path / entityId / three.js uuid fallback. A node without an
 *   address is UNADDRESSABLE; a programmatic instance (no scene) must be given
 *   an explicit id. Phase 1 only records unaddressable instances — the capture
 *   refuses them (`des-snapshot-unaddressable`) once Phase 3 activates it.
 *
 * Consumers: the DES snapshot (component keys, fingerprint) and plan-2061
 * (RNG stream key per component). The function below is THE contract.
 */

/** Separator between node address and component type. Never part of a type. */
export const DES_ID_TYPE_SEPARATOR = '@';

/** Minimal registry surface: plan-769 address of a baked node. */
export interface DesAddressSource {
  getAddressForNode(node: unknown): string | null;
}

/**
 * THE DES component id: `address + '@' + type`.
 *
 * @param address the full plan-769 node address (`<occurrence>#<NodeId>`).
 * @param type the material-flow definition type (`def.type`).
 * @throws on an empty address/type or a type that contains `'@'`.
 */
export function desComponentId(address: string, type: string): string {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('desComponentId: empty node address');
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('desComponentId: empty component type');
  }
  if (type.includes(DES_ID_TYPE_SEPARATOR)) {
    throw new Error(`desComponentId: component type '${type}' contains '${DES_ID_TYPE_SEPARATOR}'`);
  }
  return `${address}${DES_ID_TYPE_SEPARATOR}${type}`;
}

/**
 * The DES component id of `node` for `type`, or `null` when the node has no
 * plan-769 address (unaddressable — op-created, synthetic, no registry).
 */
export function desComponentIdForNode(
  registry: DesAddressSource | null | undefined,
  node: unknown,
  type: string,
): string | null {
  const address = registry?.getAddressForNode?.(node) ?? null;
  if (!address) return null;
  return desComponentId(address, type);
}

/** Split an id back into address and type (the type follows the LAST `'@'`). */
export function parseDesComponentId(id: string): { address: string; type: string } | null {
  if (typeof id !== 'string') return null;
  const at = id.lastIndexOf(DES_ID_TYPE_SEPARATOR);
  if (at <= 0 || at === id.length - 1) return null;
  return { address: id.slice(0, at), type: id.slice(at + 1) };
}

/** One instance as the identity check sees it. */
export interface DesIdentityEntry {
  /** The assigned id, `null` when unaddressable. */
  readonly desId: string | null;
  readonly type: string;
  /** Human label for problems (node path or name). */
  readonly label: string;
}

/** An instance that cannot be addressed in a snapshot. */
export interface DesUnaddressable {
  readonly reason: 'missing' | 'duplicate';
  readonly type: string;
  readonly label: string;
  readonly desId: string | null;
}

/**
 * Report every entry that cannot carry snapshot state: no id, or an id another
 * entry also carries (both are reported — neither may silently win).
 */
export function findUnaddressable(entries: readonly DesIdentityEntry[]): DesUnaddressable[] {
  const out: DesUnaddressable[] = [];
  const count = new Map<string, number>();
  for (const e of entries) if (e.desId) count.set(e.desId, (count.get(e.desId) ?? 0) + 1);
  for (const e of entries) {
    if (!e.desId) out.push({ reason: 'missing', type: e.type, label: e.label, desId: null });
    else if ((count.get(e.desId) ?? 0) > 1) out.push({ reason: 'duplicate', type: e.type, label: e.label, desId: e.desId });
  }
  return out;
}
