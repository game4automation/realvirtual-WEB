// SPDX-License-Identifier: AGPL-3.0-only
import { integer, validHandle } from '../core/source-state';
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, names: string): boolean => Object.keys(x).sort().join(',') === names.split(',').sort().join(',');
const finite = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
export function validDone(x: unknown): boolean {
  if (!record(x) || !keys(x, 'e,hj,cont') || !integer(x.e) || !integer(x.hj) || !record(x.cont)) return false;
  const c = x.cont;
  switch (c.k) {
    case 'none': case 'finishStay': return keys(c, 'k');
    case 'approachReady': return keys(c, 'k,a') && integer(c.a);
    case 'pickTouch': case 'retrieveTouch': return keys(c, 'k,station,h') && typeof c.station === 'string' && finite(c.h);
    case 'deliver': return keys(c, 'k,station') && typeof c.station === 'string';
    default: return false;
  }
}
function entries(json: unknown, key: string, valid: (x: unknown) => boolean): string[] {
  if (!record(json) || !keys(json, key) || !Array.isArray(json[key])) return ['invalid ' + key];
  const seen = new Set<string>();
  for (const pair of json[key]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0]) || !valid(pair[1])) return ['invalid ' + key + ' entry'];
    seen.add(pair[0]);
  }
  return [];
}
export function validateLiftState(json: unknown): string[] {
  return entries(json, 'strokes', s => record(s) && keys(s, 'handle,toMm,done,from,startAt,dt') && s.handle !== null && validHandle(s.handle)
    && finite(s.from) && finite(s.startAt) && finite(s.dt) && (s.dt as number) >= 0 && finite(s.toMm) && validDone(s.done));
}
export function validatePickState(json: unknown): string[] {
  return entries(json, 'pickWaiters', w => record(w) && keys(w, 'v,h,hj') && typeof w.v === 'string' && finite(w.h) && integer(w.hj));
}
