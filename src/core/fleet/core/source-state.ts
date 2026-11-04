// SPDX-License-Identifier: AGPL-3.0-only
import type { ClockHandle } from './sim-clock';
export const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export const copyHandle = (h: ClockHandle | null): ClockHandle | null => h ? { g: h.g, id: h.id } : null;
export const validHandle = (h: unknown): boolean => h === null || (!!h && typeof h === 'object'
  && Object.keys(h).sort().join(',') === 'g,id' && integer((h as ClockHandle).g) && (h as ClockHandle).g > 0
  && integer((h as ClockHandle).id));
/** Check exact record keys and primitive types without coercing snapshot data. */
export function validateShape(value: unknown, template: unknown, path = 'state'): string[] {
  if (template === null) return value === null || typeof value === 'number' && Number.isFinite(value)
    || !!value && typeof value === 'object' ? [] : [path + ': invalid nullable value'];
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) return [path + ': expected array'];
    return template.length ? value.flatMap((v, i) => validateShape(v, template[0], path + '[' + i + ']')) : [];
  }
  if (typeof template === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [path + ': expected object'];
    const t = template as Record<string, unknown>, v = value as Record<string, unknown>;
    const errors = Object.keys(v).filter(k => !Object.hasOwn(t, k)).map(k => path + '.' + k + ': unknown field');
    for (const k of Object.keys(t)) errors.push(...validateShape(v[k], t[k], path + '.' + k));
    return errors;
  }
  return typeof value === typeof template && (typeof value !== 'number' || Number.isFinite(value)) ? [] : [path + ': invalid value'];
}

/** JSON representation of limits that deliberately disable timeout scheduling. */
export type StateNumber = number | 'Infinity' | '-Infinity' | 'NaN';
export function exportNumber(n: number): StateNumber { return Number.isFinite(n) ? n : String(n) as StateNumber; }
export function importNumber(n: StateNumber): number { return typeof n === 'number' ? n : Number(n); }
export function validNumber(n: unknown): boolean {
  return typeof n === 'number' && Number.isFinite(n) || n === 'Infinity' || n === '-Infinity' || n === 'NaN';
}
