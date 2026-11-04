// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { zoneSnapshotParticipant } from '../../fleet-snapshot-participants';
import { getDefaultZoneRegistry } from '../../../core/engine/rv-zone-registry';
import { getDefaultPathNetwork } from '../../../core/engine/rv-path-network';

import { getDefaultMovementAuthority, type MovementAuthority } from '../../../core/engine/rv-movement-authority';
import { authorityStateKeys, authorityServices, authorityScratch, authorityEventHandleFields } from '../../../core/engine/rv-movement-authority-state';
import { authorityNumberSchema, decodeAuthorityData, record } from '../../../core/engine/rv-movement-authority-snapshot';
import type { SnapshotProvider } from '../rv-des-snapshot-provider';
import type { ParticipantHandleField, Snapshottable } from '../rv-snapshot-registry';
import type { SnapshotJson } from '../rv-snapshot-contract';
import { participantHandleProblems } from '../rv-des-preflight';
import type { AgvSelf } from '../../../behaviors/Agv';
import { agvStateKeys, agvServices, agvScratch } from '../../../behaviors/_shared/agv-state';
import { agvSnapshotSchema, exportAgvState, validateAgvState, prepareAgvState, swapAgvState } from '../../../behaviors/_shared/agv-snapshot';
import { registerLegPayloadCodec } from './des-leg-payload-codec';

export interface MovementSnapshotWorld {
  agvs(): ReadonlyArray<{ desId: string; vehicleId: string; self: AgvSelf }>;
}

/** Live identity wiring, never persisted state. */
export function movementSnapshotProvider(world: MovementSnapshotWorld): SnapshotProvider {
  registerLegPayloadCodec();
  return ({ raw }) => {
    const agvs = world.agvs();
    const ownerOf = (id: string): string => agvs.find(a => a.vehicleId === id)?.desId ?? '';
    const authority = getDefaultMovementAuthority('des');
    const handleFields = (json: SnapshotJson): ParticipantHandleField[] => {
      const data = record(decodeAuthorityData(json));
      const refs: ParticipantHandleField[] = [];
      for (const [i, v] of data.vehicles.entries()) {
        for (const [key, choices] of Object.entries(authorityEventHandleFields)) {
          const add = (path: string, eventId: number, zone?: string): void => {
            refs.push({ path: `vehicles[${i}].${path}`, eventId, owner: ownerOf(v.id),
              alternatives: choices.map(c => ({ action: `MF.Agv.${c.action}`, kind: c.kind })),
              ...(key === 'notifyEvents' ? { notify: true } : {}), ...(zone === undefined ? {} : { zone }) });
          };
          if (key === 'notifyEvents') v[key].forEach((n: number, j: number) => add(`${key}[${j}]`, n));
          else if (key === 'releaseEvents') v[key].forEach(([z, n]: [string, number], j: number) => add(`${key}[${j}][1]`, n, z));
          else add(key, v[key]);
        }
      }
      return refs;
    };
    const participant: Snapshottable = {
      key: 'fleet.authority', version: 1, owner: authority,
      stateKeys: authorityStateKeys, services: [...authorityServices, ...authorityScratch],
      get schema() { return authorityNumberSchema(raw?.parts.find(p => p.key === 'fleet.authority')?.state ?? authority.exportState()); },
      handleFields, captureIsEncoded: true,
      capture: () => authority.exportState(),
      validate: json => {
        const errors = [...authority.validateState(json)];
        if (!errors.length && raw) errors.push(...participantHandleProblems(handleFields(json), raw.eventQueue));
        if (!errors.length && raw) {
          const vehicles = record(decodeAuthorityData(json)).vehicles;
          for (const v of vehicles) {
            const partners = agvs.filter(a => a.vehicleId === v.id
              && raw.parts.some(p => p.key === `fleet.agv:${a.desId}`));
            if (partners.length !== 1)
              errors.push(`fleet.authority vehicle '${v.id}' requires exactly one fleet.agv participant`);
          }
          const zonesPart = raw.parts.find(p => p.key === 'fleet.zones');
          const zones = zonesPart ? record(zonesPart.state).zones : [];
          for (const v of vehicles) for (const [zone] of v.held) {
            if (!Array.isArray(zones) || !zones.some((z: { id: string; holders: string[] }) =>
              z.id === zone && Array.isArray(z.holders) && z.holders.includes(v.id))) {
              errors.push(`fleet.authority vehicle '${v.id}' held zone '${zone}' requires matching fleet.zones holder`);
            }
          }
        }
        return errors;
      },
      prepare: json => authority.prepareState(json),
      commit: prepared => authority.swapState(prepared as ReturnType<MovementAuthority['prepareState']>),
    };
    const agvParticipants: Snapshottable[] = agvs.map(({ desId, vehicleId, self }) => ({
      key: `fleet.agv:${desId}`, version: 1, owner: self.local,
      // Commit authority containers first, then Agv state. No reverse edge or cycle.
      dependencies: ['fleet.authority'],
      stateKeys: agvStateKeys, services: [...agvServices, ...agvScratch],
      schema: agvSnapshotSchema, captureIsEncoded: true,
      capture: () => exportAgvState(self),
      handleFields: json => [{ path: 'desServiceEvent', eventId: (json as { desServiceEvent: number }).desServiceEvent,
        owner: desId, alternatives: [{ action: 'MF.Agv.ServiceEnd', kind: null }] }],
      validate: json => {
        const errors = [...validateAgvState(json, vehicleId)];
        if (raw) {
          if (!errors.length) errors.push(...participantHandleProblems([
            { path: 'desServiceEvent', eventId: (json as { desServiceEvent: number }).desServiceEvent,
              owner: desId, alternatives: [{ action: 'MF.Agv.ServiceEnd', kind: null }] },
          ], raw.eventQueue));
          try {
            const authorityPart = raw.parts.find(p => p.key === 'fleet.authority');
            const vehicles = authorityPart ? record(decodeAuthorityData(authorityPart.state)).vehicles : [];
            const partners = (id: string) => agvs.filter(a => a.vehicleId === id
              && raw.parts.some(p => p.key === `fleet.agv:${a.desId}`));
            // Use the saved activation state, never the current world's config/local state.
            const active = record(json).active;
            const count = vehicles.filter((v: { id: string }) => v.id === vehicleId).length;
            if (active === true && count !== 1)
              errors.push(`fleet.agv:${desId} vehicle '${vehicleId}' requires exactly one fleet.authority vehicle`);
            if (active === false && count !== 0)
              errors.push(`fleet.agv:${desId} inactive vehicle '${vehicleId}' requires no fleet.authority vehicle`);
            for (const v of vehicles) if (partners(v.id).length !== 1)
              errors.push(`fleet.authority vehicle '${v.id}' requires exactly one fleet.agv:${ownerOf(v.id) || '<missing desId>'} (validating '${desId}', vehicle '${vehicleId}')`);
          } catch (e) { errors.push(`fleet.agv:${desId} vehicle '${vehicleId}': invalid fleet.authority: ${String(e)}`); }
        }
        return errors;
      },
      prepare: json => prepareAgvState(self, json, vehicleId),
      commit: prepared => swapAgvState(self, prepared as ReturnType<typeof prepareAgvState>),
    }));
    return [zoneSnapshotParticipant({ zones: getDefaultZoneRegistry(), paths: getDefaultPathNetwork() }), participant, ...agvParticipants];
  };
}
