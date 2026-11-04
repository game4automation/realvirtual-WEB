// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { ACTION_INDEX, getActionSchema } from './rv-des-named-actions';

/** Validate exactly the descriptor fields consumed by resume/dataFromFrozen. */
export function validateFrozen(value: unknown, mu: (id: number, gen?: number) => void, pathExists: (id: string) => boolean): void {
  const fail = (): never => { throw new Error('invalid frozen descriptor'); };
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    return v as Record<string, unknown>;
  };
  const remaining = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(); };
  const ref = (v: unknown) => {
    if (v === null) return;
    const r = record(v);
    if (!Number.isSafeInteger(r.id) || (r.id as number) < 0 || !Number.isSafeInteger(r.gen) || (r.gen as number) < 0) fail();
    mu(r.id as number, r.gen as number);
  };
  const tween = (v: unknown) => {
    const t = record(v);
    remaining(t.remaining);
    ref(t.muRef);
    const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if (t.kind === 'position') {
      if (!vec3(t.from) || !vec3(t.to)) fail();
    } else if (t.kind === 'path') {
      if (typeof t.pathRef !== 'string' || !t.pathRef || !pathExists(t.pathRef) || !Number.isFinite(t.fromS) || !Number.isFinite(t.toS)) fail();
    } else fail();
    if (t.muId !== undefined) {
      if (!Number.isSafeInteger(t.muId) || (t.muId as number) < 0) fail();
      mu(t.muId as number);
    }
  };
  // JSON tween spec as produced by DESRunner._jsonTweenSpec; the fields checked are exactly those
  // _attachTweenFromData dereferences (position/path/drive/axes).
  const spec = (v: unknown) => {
    const t = record(v);
    // Runtime-only fields are never persisted (_jsonTweenSpec strips them); a forged one would be passed
    // to the tween registry as a live target and throw on the next update.
    for (const key of ['drive', 'target', 'path', 'sAt']) if (key in t) fail();
    const vec3 = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);
    if (t.kind === 'position') { if (!vec3(t.from) || !vec3(t.to)) fail(); }
    else if (t.kind === 'path') {
      if (typeof t.pathRef !== 'string' || !t.pathRef || !pathExists(t.pathRef) || !Number.isFinite(t.fromS) || !Number.isFinite(t.toS)) fail();
    } else if (t.kind === 'drive') {
      if (!Number.isFinite(t.from) || !Number.isFinite(t.to)) fail();
    } else if (t.kind === 'axes') {
      if (!Array.isArray(t.phases)) fail();
      for (const phase of t.phases as unknown[]) {
        const ph = record(phase);
        if (!Number.isFinite(ph.at0) || !Number.isFinite(ph.at1) || !Array.isArray(ph.axes)) fail();
        for (const axis of ph.axes as unknown[]) {
          const ax = record(axis);
          if (typeof ax.driveRef !== 'string' || !Number.isFinite(ax.from) || !Number.isFinite(ax.to)) fail();
        }
      }
    } else fail();
    if (t.muId !== undefined) {
      if (!Number.isSafeInteger(t.muId) || (t.muId as number) < 0) fail();
      mu(t.muId as number);
    }
  };
  if (!Array.isArray(value)) return fail();
  for (const v of value) {
    const d = record(v);
    remaining(d.remaining);
    ref(d.muRef);
    if (typeof d.action !== 'string' || !ACTION_INDEX.has(d.action)) fail();
    const schema = getActionSchema(d.action as string);
    if (!schema || schema === 'non-persistent' || schema.nonPersistent) fail();
    // Resume reads the payload's tween/tweens first (`_attachTweensFromData` prefers payload.tweens
    // over the descriptors), so a forged payload tween would only throw after the world was replaced.
    if (d.payload !== undefined && d.payload !== null && typeof d.payload === 'object') {
      const payload = d.payload as Record<string, unknown>;
      if (payload.tween !== undefined) spec(payload.tween);
      if (payload.tweens !== undefined) {
        if (!Array.isArray(payload.tweens)) fail();
        (payload.tweens as unknown[]).forEach(spec);
      }
    }
    if (d.tween !== undefined) tween(d.tween);
    if (d.tweens !== undefined) {
      if (!Array.isArray(d.tweens)) fail();
      (d.tweens as unknown[]).forEach(tween);
    }
  }
}
