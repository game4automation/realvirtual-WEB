// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { DESManager } from './rv-des-manager';
import { captureStreamsDoc, validateStreamsDoc, applyStreamsDoc, type RngStreamsDoc } from './rv-des-rng-state';
import type { Snapshottable } from './rv-snapshot-registry';
import type { RngStream, SFC32State } from '../../core/rv-rng-distribution';

/** Run-version-selected RNG state; application preserves stable named stream handles. */
export function rngParticipant(components: ReadonlyMap<string, { rng: RngStream | null }>,
  manager?: Pick<DESManager, 'rngVersion' | 'masterSeed' | 'streamEntries' | 'stream'>,
  snapshotMasterSeed?: () => number | undefined): Snapshottable & { apply(): void } {
  if (manager?.rngVersion === 2) {
    const inScope = (id: string) => components.has(id) || id === '__manager__';
    const decode = (raw: unknown) => {
      const doc = validateStreamsDoc(raw, { knownId: inScope });
      const masterSeed = snapshotMasterSeed?.();
      if (typeof masterSeed === 'number' && masterSeed !== doc.masterSeed)
        throw new Error('RNG masterSeed differs from the des.manager masterSeed');
      return doc;
    };
    let staged: RngStreamsDoc | undefined;
    return { key: 'des.rng', version: 1,
      capture: () => captureStreamsDoc(manager.masterSeed, manager.streamEntries(), inScope),
      validate(raw) { try { decode(raw); return []; } catch (e) { return [String(e)]; } },
      prepare: decode, commit(value) { staged = value as RngStreamsDoc; },
      apply() { if (staged) applyStreamsDoc(staged, manager, inScope); },
    };
  }
  let staged: Array<{ rng: NonNullable<ReturnType<typeof components.get>>['rng']; state: SFC32State }> = [];
  const decode = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid rngStates');
    const states = (raw as { rngStates: unknown }).rngStates;
    if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error('invalid rngStates');
    for (const [id, c] of components) if (c.rng && !Object.hasOwn(states, id)) throw new Error(`missing RNG state '${id}'`);
    return Object.entries(states).map(([id, state]) => {
      const component = components.get(id);
      if (!component?.rng) throw new Error(`unknown RNG component '${id}'`);
      if (!Array.isArray(state) || state.length !== 4 || !state.every(Number.isInteger)) throw new Error(`invalid RNG state '${id}'`);
      return { rng: component.rng, state: state as SFC32State };
    });
  };
  return { key: 'des.rng', version: 1,
    capture: () => ({ rngStates: Object.fromEntries([...components].flatMap(([id, c]) => {
      if (!c.rng) return [];
      const state = c.rng.getState();
      // RNG v2 named streams carry an object state and are saved by the manager's des.rng v2 document (plan-2061 Phase 3).
      if (!Array.isArray(state)) throw new Error('rng-v2-state-invalid');
      return [[id, state]];
    })) }),
    validate(raw) { try { decode(raw); return []; } catch (e) { return [String(e)]; } },
    prepare: decode, commit(value) { staged = value as typeof staged; },
    // Application is deliberately deferred to the runner's ordered apply hook.
    apply() { for (const entry of staged) entry.rng!.setState(entry.state); },
  };
}
