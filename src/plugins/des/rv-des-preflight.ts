// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DesFingerprint } from './rv-des-fingerprint';
import { callbackOriginProblem, assertPersistableQueue, type PersistableQueueEvent } from './rv-des-action-schema';
import { getActionSchema, type ActionSchema } from './rv-des-named-actions';
import { assertSnapshotData, type SnapshotJson } from './rv-snapshot-contract';
import type { SnapshotPart, ParticipantHandleField } from './rv-snapshot-registry';

export interface Problem {
  code: 'des-snapshot-contract' | 'des-snapshot-legacy' | 'des-snapshot-fingerprint' | 'des-snapshot-agv-state';
  reason: string;
  path?: string;
}
export interface SnapshotHandleRef {
  participant: string;
  path: string;
  eventId: number;
  action: string;
  owner: string;
  expect?(event: PersistableQueueEvent): boolean;
}
export interface PreflightContext {
  fingerprint: DesFingerprint;
  participants: ReadonlyMap<string, { version: number; validate(json: SnapshotJson): readonly string[];
    handleFields?(json: SnapshotJson): readonly ParticipantHandleField[] }>;
  componentTypeOf(id: string): string | undefined;
  getActionSchema(name: string): ActionSchema | 'non-persistent' | undefined;
  desOwners?: ReadonlySet<string>;
  replanOnRestore?: ReadonlySet<string>;
  handleRefs?(parts: readonly SnapshotPart[]): SnapshotHandleRef[];
  /** Reverse ownership checks over the whole queue (e.g. orphan or duplicate timer slices). */
  queueChecks?(events: readonly PersistableQueueEvent[], parts: readonly SnapshotPart[]): readonly string[];
}
export type PreflightResult = { ok: true } | { ok: false; problems: Problem[] };

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const uint32 = (v: unknown): v is number => integer(v, 0, 2 ** 32 - 1);
const int32 = (v: unknown): v is number => integer(v, -(2 ** 31), 2 ** 31 - 1);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Read-only validation: no managers, dispatch, restore or registration. Context callbacks must be pure. */
export function preflightSnapshot(raw: unknown, ctx: PreflightContext): PreflightResult {
  return preflight(raw, ctx);
}

/** Validate the stored envelope before changing the scene; model checks follow activation. */
export function preflightSnapshotEnvelope(raw: unknown): PreflightResult {
  return preflight(raw);
}

function preflight(raw: unknown, ctx?: PreflightContext): PreflightResult {
  const problems: Problem[] = [];
  const bad = (path: string, reason: string, code: Problem['code'] = 'des-snapshot-contract'): void => {
    problems.push({ code, reason, path });
  };
  const result = (): PreflightResult => problems.length ? { ok: false, problems } : { ok: true };
  if (!record(raw)) { bad('', 'snapshot must be an object'); return result(); }
  if (raw.version !== 4 && (Object.hasOwn(raw, 'version')
    || Object.hasOwn(raw, 'components') || Object.hasOwn(raw, 'simTime') && !Object.hasOwn(raw, 'fingerprint')
    || Object.hasOwn(raw, 'currentTime') && Object.hasOwn(raw, 'events'))) {
    bad('version', 'legacy snapshot is not converted; start a new run', 'des-snapshot-legacy');
    return result();
  }
  if (raw.version !== 4) { bad('version', 'snapshot version must be 4'); return result(); }

  const f = raw.fingerprint;
  if (!record(f) || !Array.isArray(f.components)
    || !f.components.every(c => record(c) && typeof c.id === 'string' && typeof c.type === 'string')
    || typeof f.schemaVersion !== 'number' || typeof f.rngVersion !== 'number' || !Number.isInteger(f.rngVersion)
    || typeof f.modelHash !== 'string') {
    bad('fingerprint', 'invalid fingerprint');
  } else if (!ctx && (f.schemaVersion !== 4 || (f.rngVersion !== 1 && f.rngVersion !== 2))) {
    bad('fingerprint', 'unsupported schemaVersion or rngVersion');
  } else if (ctx && (f.schemaVersion !== ctx.fingerprint.schemaVersion
    // modelHash = model + release version; runConfigHash is deliberately NOT compared (Thomas 2026-11-01).
    || f.rngVersion !== ctx.fingerprint.rngVersion || f.modelHash !== ctx.fingerprint.modelHash)) {
    const saved = new Map<string, string>(f.components.map(c => [c.id, c.type]));
    const current = new Map(ctx.fingerprint.components.map(c => [c.id, c.type]));
    const reasons: string[] = [];
    for (const [id, type] of current) {
      if (!saved.has(id)) reasons.push(`missing ID '${id}' in snapshot`);
      else if (saved.get(id) !== type) reasons.push(`type changed '${id}': '${saved.get(id)}' -> '${type}'`);
    }
    for (const id of saved.keys()) if (!current.has(id)) reasons.push(`unknown ID '${id}' in snapshot`);
    if (!reasons.length) reasons.push('model changed (modelHash)');
    if (f.schemaVersion !== ctx.fingerprint.schemaVersion) reasons.push('schemaVersion mismatch');
    if (f.rngVersion !== ctx.fingerprint.rngVersion) reasons.push('rngVersion mismatch');
    bad('fingerprint', reasons.join('; '), 'des-snapshot-fingerprint');
  }

  if (!finite(raw.simTime) || raw.simTime < 0) bad('simTime', 'must be finite and >= 0');
  if (Object.hasOwn(raw, 'renderClock') && (!finite(raw.renderClock) || finite(raw.simTime) && (raw.renderClock as number) < raw.simTime))
    bad('renderClock', 'must be finite and >= simTime');
  if (!uint32(raw.nextEventId)) bad('nextEventId', 'must be an integer in [0, 2^32-1]');
  const events: PersistableQueueEvent[] = [];
  const ids = new Set<number>();
  const muRefs: Array<{ id: unknown; path: string }> = [];
  if (!Array.isArray(raw.eventQueue)) bad('eventQueue', 'must be an array');
  else for (let i = 0; i < raw.eventQueue.length; i++) {
    const e = raw.eventQueue[i];
    const path = `eventQueue[${i}]`;
    if (!record(e)) { bad(path, 'event must be an object'); continue; }
    if (!finite(e.time) || finite(raw.simTime) && e.time < raw.simTime)
      bad(`${path}.time`, 'must be finite and >= simTime');
    if (!uint32(e.id)) bad(`${path}.id`, 'must be an integer in [0, 2^32-1]');
    else {
      if (ids.has(e.id)) bad(`${path}.id`, 'duplicate event ID');
      ids.add(e.id);
      if (uint32(raw.nextEventId) && e.id >= raw.nextEventId) bad(`${path}.id`, 'must be < nextEventId');
    }
    if (!int32(e.priority)) bad(`${path}.priority`, 'must be an Int32 integer');
    if (!int32(e.muId)) bad(`${path}.muId`, 'must be an Int32 integer');
    muRefs.push({ id: e.muId, path: `${path}.muId` });
    if (e.componentId !== null && (typeof e.componentId !== 'string'
      || ctx && ctx.componentTypeOf(e.componentId) === undefined)) bad(`${path}.componentId`, 'unknown component');
    if (typeof e.action !== 'string') { bad(`${path}.action`, 'must be an action name'); continue; }
    if (e.componentId !== null && typeof e.componentId !== 'string') continue;
    let validData = true;
    if (e.data !== undefined) try { assertSnapshotData(e.data); }
    catch (error) { bad(`${path}.data`, message(error)); validData = false; }
    const event = e as unknown as PersistableQueueEvent;
    events.push(event);
    try {
      if (ctx) { for (const reason of queueProblems(event, ctx, validData)) bad(path, reason); }
      else {
        const schema = getActionSchema(event.action);
        if (schema === undefined) bad(path, 'action has no persistence schema');
        else if (validData && schema !== 'non-persistent') {
          if (schema.payload === 'none') {
            if (event.data != null) bad(path, 'action declares no payload');
          } else for (const reason of schema.payload(event.data ?? null)) bad(path, reason);
        }
      }
    }
    catch (error) { bad(path, `action validation failed: ${message(error)}`); }
  }

  const muIds = new Set<number>();
  if (!Array.isArray(raw.muIds)) bad('muIds', 'must be an array');
  else raw.muIds.forEach((id: unknown, i: number) => {
    if (!integer(id, 0, Infinity)) bad(`muIds[${i}]`, 'must be a non-negative integer');
    else { if (muIds.has(id)) bad(`muIds[${i}]`, 'duplicate MU ID'); muIds.add(id); }
  });
  for (const ref of muRefs) if (int32(ref.id) && ref.id !== -1 && !muIds.has(ref.id))
    bad(ref.path, `unknown MU '${ref.id}'`);

  const parts: SnapshotPart[] = [];
  const keys = new Set<string>();
  if (!Array.isArray(raw.parts)) bad('parts', 'must be an array');
  else raw.parts.forEach((p: unknown, i: number) => {
    const path = `parts[${i}]`;
    if (!record(p) || typeof p.key !== 'string') { bad(path, 'invalid participant part'); return; }
    if (keys.has(p.key)) bad(`${path}.key`, `duplicate participant '${p.key}'`);
    keys.add(p.key);
    const participant = ctx?.participants.get(p.key);
    if (!integer(p.version, 1, Infinity)) bad(`${path}.version`, 'must be a positive integer');
    if (ctx && !participant) bad(`${path}.key`, `unknown participant '${p.key}'`);
    else if (participant && p.version !== participant.version) bad(`${path}.version`, `participant '${p.key}' version mismatch`);
    try { assertSnapshotData(p.state, { participant: p.key }); }
    catch (error) { bad(`${path}.state`, message(error)); return; }
    parts.push(p as unknown as SnapshotPart);
    if (participant) try {
      for (const reason of participant.validate(p.state)) {
        if (p.key.startsWith('fleet.agv:') && reason.startsWith('des-snapshot-agv-state:'))
          problems.push({ code: 'des-snapshot-agv-state', path: `${path}.state`, reason });
        else bad(`${path}.state`, reason);
      }
      if (participant.handleFields) for (const reason of participantHandleProblems(participant.handleFields(p.state as SnapshotJson), events)) bad(`${path}.state`, reason);
    } catch (error) { bad(`${path}.state`, `participant validation failed: ${message(error)}`); }
  });
  for (const key of ctx?.participants.keys() ?? []) if (!keys.has(key)) bad('parts', `missing participant '${key}'`);

  if (ctx?.handleRefs) try {
    const byId = new Map(events.map(e => [e.id, e]));
    for (const ref of ctx.handleRefs(parts)) {
      if (ref.eventId === -1) continue;
      const e = byId.get(ref.eventId);
      const schema = e && ctx.getActionSchema(e.action);
      const owner = schema && schema !== 'non-persistent'
        ? schema.owner === 'component' ? e!.componentId : schema.owner : e?.componentId;
      if (!uint32(ref.eventId) || !e || e.action !== ref.action || owner !== ref.owner || ref.expect && !ref.expect(e))
        bad(`parts.${ref.participant}.${ref.path}`, `event handle '${ref.eventId}' has missing event, wrong action or wrong owner`);
    }
  } catch (error) { bad('parts', `handle validation failed: ${message(error)}`); }
  if (ctx?.queueChecks) try {
    for (const reason of ctx.queueChecks(events, parts)) bad('eventQueue', reason);
  } catch (error) { bad('eventQueue', `queue validation failed: ${message(error)}`); }
  return result();
}

/** Owner is the component DES id; kind lives inside HookEventData.data. */
export function participantHandleProblems(refs: readonly ParticipantHandleField[], events: readonly PersistableQueueEvent[]): string[] {
  const errors: string[] = [];
  const queue = new Map(events.map(e => [e.id, e]));
  for (const ref of refs) {
    if (ref.eventId === -1) continue;
    const e = queue.get(ref.eventId);
    const user = e && record(e.data) ? e.data.data : undefined;
    const kind = record(user) ? user.kind : undefined;
    if (!Number.isInteger(ref.eventId) || !e || e.componentId !== ref.owner
      || !ref.alternatives.some(a => a.action === e.action && (a.kind === null ? kind === undefined : a.kind === kind))
      || ref.notify && (!record(user) || user.ev !== ref.eventId)
      || ref.zone !== undefined && (!record(user) || user.zone !== ref.zone))
      errors.push(`${ref.path}: event handle '${ref.eventId}' has missing event, wrong owner, action or payload`);
  }
  return errors;
}

/** B currently has a fixed global lookup. Reuse it when identical; keep injected lookups local. */
function queueProblems(event: PersistableQueueEvent, ctx: PreflightContext, validData: boolean): readonly string[] {
  const schema = ctx.getActionSchema(event.action);
  const participants = new Set(ctx.participants.keys());
  if (validData && schema === getActionSchema(event.action)) return assertPersistableQueue([event], {
    participants, componentTypeOf: id => ctx.componentTypeOf(id), desOwners: ctx.desOwners, replanOnRestore: ctx.replanOnRestore,
  }).map(p => p.reason);
  if (schema === undefined) return ['action has no persistence schema'];
  if (schema !== 'non-persistent' && schema.originRequired) {
    const reason = callbackOriginProblem(event, ctx.replanOnRestore);
    return reason ? [reason] : [];
  }
  if (schema === 'non-persistent') return event.componentId !== null && (ctx.desOwners
    ? ctx.desOwners.has(event.componentId)
    : participants.has(event.componentId) || ctx.componentTypeOf(event.componentId) !== undefined)
    ? [`non-persistent action belongs to DES owner '${event.componentId}'`] : [];
  const reasons: string[] = [];
  if (schema.owner === 'component') {
    const type = event.componentId === null ? undefined : ctx.componentTypeOf(event.componentId);
    if (type === undefined) reasons.push(`unknown component '${event.componentId}'`);
    else if (schema.targetType !== undefined && schema.targetType !== type)
      reasons.push(`target type '${type}' does not match '${schema.targetType}'`);
    if (event.componentId === null || !participants.has(event.componentId))
      reasons.push(`owner participant '${event.componentId}' is not registered`);
  } else if (!participants.has(schema.owner)) reasons.push(`owner participant '${schema.owner}' is not registered`);
  if (!validData) return reasons;
  if (schema.payload === 'none') {
    if (event.data != null) reasons.push('action declares no payload');
  } else reasons.push(...schema.payload(event.data ?? null));
  return reasons;
}
