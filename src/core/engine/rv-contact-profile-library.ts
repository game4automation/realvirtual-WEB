// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-contact-profile-library.ts — the profile library behind
 * `ContactProfile.Profile` (plan-673 Phase 2).
 *
 * A role name on a node resolves to one set of contact numbers HERE, not in the
 * model. That is the whole point: a surface measured once is corrected once, in
 * the library, instead of in every GLB that touches it.
 *
 * `contact-profiles.json` next to this file is the shipped default. A project
 * may replace it with its own catalogue through {@link setContactProfileCatalog}
 * — same shape, validated, and a rejected catalogue leaves the previous one in
 * place rather than half-applying.
 *
 * Every entry declares its PROVENANCE, and today almost all of them are
 * `declared` — a plausible starting assumption, not a datasheet value.
 * {@link unmeasuredProfileRoles} exists so a report can say which ones still
 * are, instead of the numbers quietly acquiring an authority they do not have.
 */

import defaultCatalog from './contact-profiles.json';
import {
  COND_DIM_VALUES,
  condimOf,
  CONTACT_PROFILE_ROLES,
  type ContactProfileRole,
} from './rv-contact-geometry';

/** How a number in the library came to be. */
export type ContactProvenance = 'measured' | 'derived' | 'declared';

/** The resolved contact numbers of one role, in MuJoCo's own terms. */
export interface ContactProfileEntry {
  /** MuJoCo `condim`: 1, 3, 4 or 6. */
  readonly condim: number;
  /** MuJoCo `friction`: sliding, torsional, rolling. */
  readonly friction: readonly [number, number, number];
  /** MuJoCo `solref`: time constant (s), damping ratio. */
  readonly solref: readonly [number, number];
  /** MuJoCo `solimp`: dmin, dmax, width, midpoint, power. */
  readonly solimp: readonly [number, number, number, number, number];
  readonly contype: number;
  readonly conaffinity: number;
  /** 1 = this side decides friction and compliance for every pairing it joins. */
  readonly priority: number;
  readonly provenance: ContactProvenance;
  readonly note: string;
}

/** One named special pairing — the `<contact><pair>` form, for cases priority cannot express. */
export interface ContactPairEntry {
  readonly a: ContactProfileRole;
  readonly b: ContactProfileRole;
  readonly friction: readonly [number, number, number];
  readonly condim: number;
  readonly provenance: ContactProvenance;
  readonly note: string;
}

export interface ContactProfileCatalog {
  readonly version: number;
  readonly profiles: Readonly<Record<string, ContactProfileEntry>>;
  readonly pairs: readonly ContactPairEntry[];
}

/** Roles a catalogue must carry — every `ContactProfile.Profile` value but `Custom`. */
export const LIBRARY_ROLES: readonly ContactProfileRole[] =
  Object.freeze(CONTACT_PROFILE_ROLES.filter((r) => r !== 'Custom'));

/** The four `condim` values MuJoCo accepts — what a catalogue entry may carry. */
const MUJOCO_CONDIMS: readonly number[] = Object.freeze(Object.values(COND_DIM_VALUES));

function isNumberArray(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Validate a catalogue. Returns the problems found, empty when it is usable.
 * A catalogue is either wholly accepted or wholly rejected: a half-applied
 * library would give two nodes of the same role different numbers.
 */
export function validateContactProfileCatalog(raw: unknown): string[] {
  const problems: string[] = [];
  const cat = raw as Partial<ContactProfileCatalog> | null;
  if (!cat || typeof cat !== 'object') return ['catalogue is not an object'];
  if (cat.version !== 1) problems.push(`unsupported version ${String(cat.version)} (expected 1)`);
  const profiles = (cat.profiles ?? {}) as Record<string, Partial<ContactProfileEntry>>;
  for (const role of LIBRARY_ROLES) {
    const e = profiles[role];
    if (!e) { problems.push(`missing role ${role}`); continue; }
    if (typeof e.condim !== 'number' || !MUJOCO_CONDIMS.includes(e.condim)) problems.push(`${role}.condim must be 1, 3, 4 or 6`);
    if (!isNumberArray(e.friction, 3)) problems.push(`${role}.friction must be three numbers`);
    if (!isNumberArray(e.solref, 2)) problems.push(`${role}.solref must be two numbers`);
    if (!isNumberArray(e.solimp, 5)) problems.push(`${role}.solimp must be five numbers`);
    if (typeof e.priority !== 'number' || e.priority < 0) problems.push(`${role}.priority must be a non-negative number`);
    if (e.provenance !== 'measured' && e.provenance !== 'derived' && e.provenance !== 'declared') {
      problems.push(`${role}.provenance must be measured, derived or declared`);
    }
    if (typeof e.note !== 'string' || e.note.length === 0) problems.push(`${role}.note must not be empty`);
  }
  const pairs = cat.pairs;
  if (pairs !== undefined && !Array.isArray(pairs)) problems.push('pairs must be an array');
  for (const [i, p] of (Array.isArray(pairs) ? pairs : []).entries()) {
    if (!LIBRARY_ROLES.includes(p.a)) problems.push(`pairs[${i}].a is not a library role`);
    if (!LIBRARY_ROLES.includes(p.b)) problems.push(`pairs[${i}].b is not a library role`);
    if (!isNumberArray(p.friction, 3)) problems.push(`pairs[${i}].friction must be three numbers`);
  }
  return problems;
}

let _catalog: ContactProfileCatalog = defaultCatalog as unknown as ContactProfileCatalog;

/** The catalogue in force. */
export function getContactProfileCatalog(): ContactProfileCatalog {
  return _catalog;
}

/**
 * Replace the catalogue from a project file. Returns the validation problems;
 * on a non-empty result nothing changed.
 */
export function setContactProfileCatalog(raw: unknown): string[] {
  const problems = validateContactProfileCatalog(raw);
  if (problems.length === 0) _catalog = raw as ContactProfileCatalog;
  return problems;
}

/** Back to the shipped default (model switch, tests). */
export function resetContactProfileCatalog(): void {
  _catalog = defaultCatalog as unknown as ContactProfileCatalog;
}

/** The entry of `role`, or `null` for `Custom` and for an unknown name. */
export function contactProfileEntry(role: string): ContactProfileEntry | null {
  return _catalog.profiles[role] ?? null;
}

/** The named special pairing of two roles, in either order, or `null`. */
export function contactProfilePair(a: string, b: string): ContactPairEntry | null {
  for (const p of _catalog.pairs ?? []) {
    if ((p.a === a && p.b === b) || (p.a === b && p.b === a)) return p;
  }
  return null;
}

/** The authored side of the resolution — the fields of one `ContactProfile`. */
export interface AuthoredContactProfile {
  readonly Profile: string;
  readonly Priority: number;
  readonly Solmix: number;
  readonly FrictionSlide: number;
  readonly FrictionSpin: number;
  readonly FrictionRoll: number;
  /** The stored NAME (`'SlidingTorsional'`), not the MuJoCo number. */
  readonly CondDim: string;
  readonly SolrefTimeConst: number;
  readonly SolrefDampRatio: number;
}

/** The effective numbers of one node, plus the `solmix` the pairing average uses. */
export interface ResolvedContactProfile extends ContactProfileEntry {
  readonly solmix: number;
}

/**
 * The effective contact numbers of one authored `ContactProfile`: the library
 * entry for a named role, the component's own fields for `Custom`. `Priority`
 * and `Solmix` are ALWAYS the authored ones — they say how this side takes part
 * in a pairing, which is a decision about this node and not a property of the
 * role.
 *
 * This is the only place the precedence is decided, so the MJCF writer, the
 * inspector and a report cannot disagree about it.
 */
export function resolveContactProfile(authored: AuthoredContactProfile): ResolvedContactProfile {
  const entry = authored.Profile === 'Custom' ? null : contactProfileEntry(authored.Profile);
  if (entry) {
    return { ...entry, priority: authored.Priority, solmix: authored.Solmix };
  }
  return {
    condim: condimOf(authored.CondDim),
    friction: [authored.FrictionSlide, authored.FrictionSpin, authored.FrictionRoll],
    solref: [authored.SolrefTimeConst, authored.SolrefDampRatio],
    // solimp has deliberately no field (see the schema): it belongs to the
    // profile, and whoever needs it per node has a different problem.
    solimp: [0.9, 0.95, 0.001, 0.5, 2],
    contype: 1,
    conaffinity: 1,
    priority: authored.Priority,
    solmix: authored.Solmix,
    provenance: 'declared',
    note: authored.Profile === 'Custom'
      ? 'Custom: the numbers on the component itself.'
      : `Unknown profile role "${authored.Profile}" — the component's own numbers are used.`,
  };
}

/** The roles whose numbers are still a declared assumption rather than a measurement. */
export function unmeasuredProfileRoles(): ContactProfileRole[] {
  return LIBRARY_ROLES.filter((r) => _catalog.profiles[r]?.provenance === 'declared');
}
