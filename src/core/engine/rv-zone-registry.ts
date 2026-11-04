// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-zone-registry.ts — control-point / zone reservation (plan-268 Phase 2).
 *
 * Zones model mutual exclusion at junctions/crossings the way professional
 * material-flow tools do (FlexSim control points, Plant Simulation occupancy):
 * a vehicle CLAIMS a zone before entering and RELEASES it after leaving — no
 * physics, no raycast. A zone has a capacity (default 1); `claim` fails when
 * the capacity is exhausted and the vehicle holds at the zone entrance via the
 * headway stop mechanics (Agv.ts).
 *
 * Zones are declared in the WebViewer-native `rv_extras.Path` schema as the
 * path-level attributes `zone` (id) + `zoneCapacity` (see rv-path.ts, the
 * TS-SSOT of the schema): a zone is the set of paths sharing the same `zone`
 * id — a crossing is simply two crossing paths tagged with the same id.
 *
 * MANDATORY lifecycle rules (plan-268 §2.4, review finding 2):
 *   - Claims are indexed PER HOLDER (`releaseAll(agvId)`) so a reset, dispose
 *     or despawn can always free everything an AGV holds. A held claim that
 *     survives its holder would block the crossing PERMANENTLY — and a timeout
 *     can never heal that (in DES/FastForward no wall-clock time passes).
 *   - `clear()` drops every zone, declaration and claim (model switch / test
 *     reset — `resetTrafficRegistries()`).
 *   - Zones have DECLARANTS (plan-647 D4): the `RVPath` object that declares
 *     the zone (`declare` / `redeclare` / `withdraw`). Removing one path of a
 *     shared zone withdraws only its own declaration — the zone and the
 *     claims of other vehicles stay as long as another path declares it.
 *   - `claim`/`release` are public API — project scripts may reserve zones
 *     (stations, charging bays) with the exact same calls the Agv uses.
 */

/** Capacity used for zones that were never explicitly declared. */
export const DEFAULT_ZONE_CAPACITY = 1;

/**
 * The declarant behind the deprecated {@link ZoneRegistry.define} /
 * {@link ZoneRegistry.redefine} wrappers: callers that declare without an
 * owner share this one anonymous declaration (MAX-WINS, as before plan-647).
 */
const LEGACY_DECLARANT: object = Object.freeze({ legacyZoneDeclarant: true });

interface ZoneState {
  /**
   * Effective declared capacity = maximum over the finite declarations;
   * undefined = no declaration carries a capacity ("undeclared").
   */
  capacity: number | undefined;
  /**
   * Declarations (plan-647 D4): declarant → declared capacity (undefined =
   * declared without a capacity). The declarant is the `RVPath` OBJECT that
   * declares the zone; identity, not id, so two placements with equal path ids
   * stay two declarants.
   */
  declarations: Map<object, number | undefined>;
  /** Current holders (agv/actor ids). */
  holders: Set<string>;
}

/** Options of {@link ZoneRegistry.withdraw}. */
export interface ZoneWithdrawOptions {
  /**
   * What happens when the LAST declaration goes: `false` drops the zone with
   * every holder (the path left the scene: dispose, placement removal);
   * `true` keeps the zone and its holders as "undeclared" (a live edit moved
   * the path to another zone; a vehicle inside still holds its claim).
   */
  preserveHolders: boolean;
}

/** Normalised capacity: finite → floor(max(0, c)); anything else → undefined. */
function normCapacity(capacity: number | undefined): number | undefined {
  return capacity === undefined || !Number.isFinite(capacity) ? undefined : Math.max(0, Math.floor(capacity));
}

export interface ZoneRegistryState {
  zones: Array<{ id: string; capacity: number | null;
    declarations: Array<{ declarant: string; capacity: number | null }>; holders: string[] }>;
  byHolder: Array<{ holder: string; held: string[] }>;
}
export interface ZoneDeclarantCodec {
  idOf(declarant: object): string | null;
  resolve(id: string): object | null;
}
declare const preparedZoneRegistryBrand: unique symbol;
export interface PreparedZoneRegistry { readonly [preparedZoneRegistryBrand]: true }
const preparedZoneRegistries = new WeakMap<PreparedZoneRegistry, {
  zones: Map<string, ZoneState>; byHolder: Map<string, Set<string>>;
}>();

/**
 * Zone claim registry. The shared instance is {@link defaultZoneRegistry};
 * tests may construct their own isolated registry.
 */
export class ZoneRegistry {
  private zones = new Map<string, ZoneState>();
  private byHolder = new Map<string, Set<string>>();
  /**
   * Availability listeners (plan-558): notified on EVERY change that can let a
   * waiting vehicle in — release, releaseAll, a capacity increase via
   * declare/redeclare/withdraw, a dropped zone — so waiters are woken by a
   * trigger instead of a poll. The movement authorities (DES + continuous)
   * subscribe here.
   */
  private readonly availabilityListeners = new Set<(zoneId: string) => void>();

  exportState(codec: ZoneDeclarantCodec): ZoneRegistryState {
    return { zones: [...this.zones].map(([id, z]) => ({ id, capacity: z.capacity ?? null,
      declarations: [...z.declarations].map(([owner, capacity]) => {
        const declarant = owner === LEGACY_DECLARANT ? '$legacy' : codec.idOf(owner);
        if (declarant === null) throw new Error('zones: unknown declarant identity');
        if (owner !== LEGACY_DECLARANT && declarant === '$legacy') throw new Error('zones: reserved declarant ID');
        return { declarant, capacity: capacity ?? null };
      }), holders: [...z.holders] })),
      byHolder: [...this.byHolder].map(([holder, held]) => ({ holder, held: [...held] })) };
  }

  static validateState(value: unknown, codec?: ZoneDeclarantCodec): string[] {
    const errors: string[] = [];
    const record = (v: unknown, fields: string[], path: string): v is Record<string, unknown> => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errors.push(`${path}: expected object`); return false;
      }
      for (const field of fields) if (!Object.hasOwn(v, field)) errors.push(`${path}.${field}: required`);
      for (const field of Object.keys(v)) if (!fields.includes(field)) errors.push(`${path}.${field}: unknown field`);
      return true;
    };
    const array = (v: unknown, path: string): v is unknown[] => {
      if (Array.isArray(v)) return true;
      errors.push(`${path}: expected array`); return false;
    };
    const id = (v: unknown, seen: Set<string>, path: string): void => {
      if (typeof v !== 'string' || !v.length) errors.push(`${path}: expected non-empty ID`);
      else if (seen.has(v)) errors.push(`${path}: duplicate ID ${v}`);
      else seen.add(v);
    };
    const capacity = (v: unknown, path: string): void => {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0))
        errors.push(`${path}: expected non-negative integer or null`);
    };
    const refs = (v: unknown, path: string): void => {
      if (array(v, path)) {
        const seen = new Set<string>();
        v.forEach((ref, i) => id(ref, seen, `${path}[${i}]`));
      }
    };
    if (!record(value, ['zones', 'byHolder'], 'zones')) return errors;
    if (array(value.zones, 'zones.zones')) {
      const seen = new Set<string>();
      value.zones.forEach((z, i) => {
        const path = `zones[${i}]`;
        if (!record(z, ['id', 'capacity', 'declarations', 'holders'], path)) return;
        id(z.id, seen, `${path}.id`);
        capacity(z.capacity, `${path}.capacity`);
        refs(z.holders, `${path}.holders`);
        if (array(z.declarations, `${path}.declarations`)) {
          const owners = new Set<string>();
          z.declarations.forEach((c, j) => {
            const cp = `${path}.declarations[${j}]`;
            if (!record(c, ['declarant', 'capacity'], cp)) return;
            id(c.declarant, owners, `${cp}.declarant`);
            if (c.declarant !== '$legacy' && codec && typeof c.declarant === 'string' && codec.resolve(c.declarant) === null) errors.push(`${cp}.declarant: unknown declarant`);
            capacity(c.capacity, `${cp}.capacity`);
          });
        }
      });
    }
    if (array(value.byHolder, 'zones.byHolder')) {
      const seen = new Set<string>();
      value.byHolder.forEach((h, i) => {
        const path = `byHolder[${i}]`;
        if (!record(h, ['holder', 'held'], path)) return;
        id(h.holder, seen, `${path}.holder`);
        refs(h.held, `${path}.held`);
      });
    }
    if (errors.length) return errors;
    const data = value as unknown as ZoneRegistryState;
    const zones = new Map(data.zones.map(z => [z.id, z]));
    const holders = new Map(data.byHolder.map(h => [h.holder, new Set(h.held)]));
    for (const [i, z] of data.zones.entries()) {
      const declared = z.declarations.flatMap(c => c.capacity === null ? [] : [c.capacity]);
      const effective = declared.length ? Math.max(...declared) : null;
      if (z.capacity !== effective) errors.push(`zones[${i}].capacity: differs from declarations`);
      // Live capacity reductions can legitimately leave more holders than slots.
      for (const [j, holder] of z.holders.entries()) if (!holders.get(holder)?.has(z.id))
        errors.push(`zones[${i}].holders[${j}]: missing byHolder link for ${holder}/${z.id}`);
    }
    for (const [i, h] of data.byHolder.entries()) for (const [j, zone] of h.held.entries()) {
      const z = zones.get(zone);
      if (!z) errors.push(`byHolder[${i}].held[${j}]: unknown zone ${zone}`);
      else if (!z.holders.includes(h.holder)) errors.push(`byHolder[${i}].held[${j}]: missing holders link for ${h.holder}/${zone}`);
    }
    return errors;
  }

  prepareState(state: unknown, codec: ZoneDeclarantCodec): PreparedZoneRegistry {
    const errors = ZoneRegistry.validateState(state, codec);
    if (errors.length) throw new Error(errors.join('; '));
    const data = state as ZoneRegistryState;
    const zones = new Map<string, ZoneState>();
    for (const z of data.zones) {
      const declarations = new Map<object, number | undefined>();
      for (const d of z.declarations) {
        const owner = d.declarant === '$legacy' ? LEGACY_DECLARANT : codec.resolve(d.declarant);
        if (owner === null) throw new Error('zones: unknown declarant identity');
        if (declarations.has(owner)) throw new Error('zones: duplicate declarant identity');
        declarations.set(owner, d.capacity ?? undefined);
      }
      zones.set(z.id, { capacity: z.capacity ?? undefined, declarations, holders: new Set(z.holders) });
    }
    const prepared = Object.freeze({}) as PreparedZoneRegistry;
    preparedZoneRegistries.set(prepared, { zones,
      byHolder: new Map(data.byHolder.map(h => [h.holder, new Set(h.held)])) });
    return prepared;
  }

  swapState(prepared: PreparedZoneRegistry): void {
    const state = preparedZoneRegistries.get(prepared)!;
    this.zones = state.zones;
    this.byHolder = state.byHolder;
  }

  /** Subscribe to availability changes. Returns the unsubscribe function. */
  onAvailabilityChanged(cb: (zoneId: string) => void): () => void {
    this.availabilityListeners.add(cb);
    return () => { this.availabilityListeners.delete(cb); };
  }

  /**
   * Number of availability subscribers (plan-645 N3, read only). `clear()` keeps
   * them on purpose (the movement authorities subscribe once), so a consumer
   * that forgot to unsubscribe stays invisible in the registry sizes — this
   * count makes it visible.
   */
  get listenerCount(): number {
    return this.availabilityListeners.size;
  }

  private notifyAvailable(zoneId: string): void {
    for (const cb of this.availabilityListeners) cb(zoneId);
  }

  private zone(zoneId: string): ZoneState {
    let z = this.zones.get(zoneId);
    if (!z) {
      z = { capacity: undefined, declarations: new Map(), holders: new Set() };
      this.zones.set(zoneId, z);
    }
    return z;
  }

  /** Recompute the effective declared capacity (MAX over the declarations). */
  private static effective(z: ZoneState): number | undefined {
    let cap: number | undefined;
    for (const c of z.declarations.values()) {
      if (c !== undefined && (cap === undefined || c > cap)) cap = c;
    }
    return cap;
  }

  /** Drop a zone with every holder (no notification). */
  private drop(zoneId: string, z: ZoneState): void {
    for (const holder of z.holders) this.byHolder.get(holder)?.delete(zoneId);
    this.zones.delete(zoneId);
  }

  /**
   * Make sure the zone exists — no declaration, capacity and holders untouched
   * (plan-647 R4-1: a claim walk on a path object that is no longer the
   * registered one must not declare).
   */
  ensureZone(zoneId: string): void {
    this.zone(zoneId);
  }

  /**
   * Declare a zone on behalf of `declarant` (plan-647 D4). Idempotent per
   * (zone, declarant): repeating it changes nothing. Several declarants with
   * different capacities → the MAXIMUM wins, regardless of load order; a
   * repeated declaration by the same declarant keeps the larger of its two
   * values. `capacity` undefined declares without a capacity (effective
   * capacity stays "undeclared" → {@link DEFAULT_ZONE_CAPACITY} unless another
   * declarant carries one).
   */
  declare(zoneId: string, declarant: object, capacity?: number): void {
    const z = this.zone(zoneId);
    const c = normCapacity(capacity);
    const has = z.declarations.has(declarant);
    const prev = z.declarations.get(declarant);
    if (has && (c === undefined || (prev !== undefined && prev >= c))) return; // idempotent repeat
    z.declarations.set(declarant, prev === undefined ? c : Math.max(prev, c ?? prev));
    const before = z.capacity ?? DEFAULT_ZONE_CAPACITY;
    z.capacity = ZoneRegistry.effective(z);
    if ((z.capacity ?? DEFAULT_ZONE_CAPACITY) > before) this.notifyAvailable(zoneId);
  }

  /**
   * LIVE-EDIT re-declaration (plan-447, plan-647 D4): HARD-overwrite the OWN
   * declaration of `declarant` (a shrink takes effect against its own earlier
   * value) and keep every current holder. The effective capacity is the
   * maximum over all declarations again, so a shrink is bounded by what other
   * declarants of the same zone declare. Always notifies (as before).
   */
  redeclare(zoneId: string, declarant: object, capacity?: number): void {
    const z = this.zone(zoneId);
    z.declarations.set(declarant, normCapacity(capacity));
    z.capacity = ZoneRegistry.effective(z);
    this.notifyAvailable(zoneId);
  }

  /**
   * Remove the OWN declaration of `declarant` (plan-647 D4, R3-3). While
   * another declarant remains, the zone and EVERY holder stay and the
   * capacity is recomputed. When the last declaration goes,
   * `preserveHolders` decides: `false` drops the zone with its holders,
   * `true` keeps it with its holders as "undeclared". No-op when `declarant`
   * never declared the zone.
   */
  withdraw(zoneId: string, declarant: object, opts: ZoneWithdrawOptions): void {
    const z = this.zones.get(zoneId);
    if (!z || !z.declarations.delete(declarant)) return;
    if (z.declarations.size === 0 && !opts.preserveHolders) {
      this.drop(zoneId, z);
      this.notifyAvailable(zoneId);
      return;
    }
    z.capacity = ZoneRegistry.effective(z);
    this.notifyAvailable(zoneId);
  }

  /**
   * LIVE-EDIT swap of one declaration (plan-647 D4 / R4-1): withdraw `prev`
   * keeping the holders (also when it was the last declaration — the zone
   * stays "undeclared"), then HARD-declare `next` (as {@link redeclare}), and
   * only THEN notify. An availability notification can flush the planner
   * synchronously, so it must publish the finished state, never a half-swapped
   * one. Notifies the old zone (when it differs) and the new zone.
   */
  replaceDeclaration(
    prev: { zoneId: string; declarant: object } | null,
    next: { zoneId: string; declarant: object; capacity?: number } | null,
  ): void {
    if (prev) {
      const z = this.zones.get(prev.zoneId);
      if (z && z.declarations.delete(prev.declarant)) z.capacity = ZoneRegistry.effective(z);
    }
    if (next) {
      const z = this.zone(next.zoneId);
      z.declarations.set(next.declarant, normCapacity(next.capacity));
      z.capacity = ZoneRegistry.effective(z);
    }
    if (prev && prev.zoneId !== next?.zoneId) this.notifyAvailable(prev.zoneId);
    if (next) this.notifyAvailable(next.zoneId);
  }

  /**
   * @deprecated plan-647: use {@link declare} with an owner. Declares on behalf
   * of one shared anonymous declarant (MAX-WINS as before); `capacity`
   * undefined only ensures the zone exists.
   */
  define(zoneId: string, capacity?: number): void {
    if (normCapacity(capacity) === undefined) {
      this.zone(zoneId);
      return;
    }
    this.declare(zoneId, LEGACY_DECLARANT, capacity);
  }

  /**
   * @deprecated plan-647: use {@link redeclare} with an owner. Hard-overwrites
   * the shared anonymous declaration, holders kept; `capacity` undefined
   * resets that declaration to "undeclared".
   */
  redefine(zoneId: string, capacity?: number): void {
    this.redeclare(zoneId, LEGACY_DECLARANT, capacity);
  }

  /**
   * @deprecated plan-647: use {@link withdraw}. Drops a zone entirely (every
   * declaration AND every holder).
   */
  undefine(zoneId: string): void {
    const z = this.zones.get(zoneId);
    if (!z) return;
    this.drop(zoneId, z);
    this.notifyAvailable(zoneId);
  }

  /** Number of declarants of `zoneId` (0 for unknown zones) — diagnostics/tests. */
  declarantCount(zoneId: string): number {
    return this.zones.get(zoneId)?.declarations.size ?? 0;
  }

  /** True when `declarant` currently declares `zoneId` — diagnostics/tests. */
  isDeclaredBy(zoneId: string, declarant: object): boolean {
    return this.zones.get(zoneId)?.declarations.has(declarant) ?? false;
  }

  /** True when the zone exists (declared, ensured or claimed). */
  has(zoneId: string): boolean {
    return this.zones.has(zoneId);
  }

  /** Number of zones (diagnostics, plan-647 F5). */
  get size(): number {
    return this.zones.size;
  }

  /** Number of claims over all zones (diagnostics, plan-647 F5). */
  totalHolderCount(): number {
    let n = 0;
    for (const z of this.zones.values()) n += z.holders.size;
    return n;
  }

  /** Effective capacity: explicit declaration, else {@link DEFAULT_ZONE_CAPACITY}. */
  capacityOf(zoneId: string): number {
    return this.zones.get(zoneId)?.capacity ?? DEFAULT_ZONE_CAPACITY;
  }

  /**
   * Try to claim `zoneId` for `agvId`. Idempotent for the current holder
   * (re-claiming a zone you already hold is `true` and does not double-count).
   * Returns `false` when the capacity is exhausted (capacity 0 always fails).
   */
  claim(zoneId: string, agvId: string): boolean {
    const z = this.zone(zoneId);
    if (z.holders.has(agvId)) return true;
    if (z.holders.size >= (z.capacity ?? DEFAULT_ZONE_CAPACITY)) return false;
    z.holders.add(agvId);
    let held = this.byHolder.get(agvId);
    if (!held) {
      held = new Set();
      this.byHolder.set(agvId, held);
    }
    held.add(zoneId);
    return true;
  }

  /** Release one claim. No-op when `agvId` does not hold `zoneId`. */
  release(zoneId: string, agvId: string): void {
    const had = this.zones.get(zoneId)?.holders.delete(agvId) ?? false;
    this.byHolder.get(agvId)?.delete(zoneId);
    if (had) this.notifyAvailable(zoneId);
  }

  /**
   * Release EVERY zone held by `agvId` — MUST be called from the component's
   * reset/dispose/despawn hooks (plan-268 review finding 2: a stale claim is a
   * permanent deadlock; no timeout can heal it in DES/FastForward).
   */
  releaseAll(agvId: string): void {
    const held = this.byHolder.get(agvId);
    if (!held) return;
    const freed = [...held];
    for (const zoneId of held) this.zones.get(zoneId)?.holders.delete(agvId);
    held.clear();
    for (const zoneId of freed) this.notifyAvailable(zoneId);
  }

  /** Drop every zone, declaration and claim (model switch / test reset). */
  clear(): void {
    this.zones.clear();
    this.byHolder.clear();
  }

  /** True when `agvId` currently holds `zoneId`. */
  isHolder(zoneId: string, agvId: string): boolean {
    return this.zones.get(zoneId)?.holders.has(agvId) ?? false;
  }

  /** Detached holder ids for timeout diagnostics. */
  holdersOf(zoneId: string): string[] { return [...(this.zones.get(zoneId)?.holders ?? [])]; }

  /** Number of current holders of `zoneId` (0 for unknown zones). */
  holderCount(zoneId: string): number {
    return this.zones.get(zoneId)?.holders.size ?? 0;
  }

  /**
   * Copy the ids of all zones held by `agvId` into `out` (reused caller
   * buffer — no allocation in the tick). Returns the count. Use this instead
   * of iterating internal state when releases happen during the scan.
   */
  collectHeld(agvId: string, out: string[]): number {
    out.length = 0;
    const held = this.byHolder.get(agvId);
    if (!held) return 0;
    for (const zoneId of held) out.push(zoneId);
    return out.length;
  }
}

/** The shared registry the scene loader's Path components declare zones into. */
export const defaultZoneRegistry = new ZoneRegistry();

/** Accessor for the shared registry (symmetry with the other engine singletons). */
export function getDefaultZoneRegistry(): ZoneRegistry {
  return defaultZoneRegistry;
}
