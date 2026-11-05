// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * format-sim-time.ts — shared sim-clock formatter for the sim-control toolbars
 * (continuous planner clock + DES clock). DD:HH:MM:SS with a tenths digit on the
 * seconds so sub-second progress is visible, mirroring the C# DESManager time.
 */

/** Rounded completion time as HH:MM:SS, with hours allowed to exceed 24. */
export function formatRunFinishedTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Format seconds to an editable DD:HH:MM:SS string (no tenths) for inputs. */
export function formatDesDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const s = Math.floor(totalSeconds);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 86400))}:${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * Seconds as the strict `DD:HH:MM:SS(.ffffff)` argument of the des.* commands. The WHOLE duration is
 * rounded to microseconds first, so a fraction carries into seconds, minutes, hours and days
 * (0.9999999 → 00:00:00:01). Infinite → `inf`, 0 → `00:00:00:00`. A positive value below 1 µs and a
 * negative value give null: they must never be encoded as 0, which means "indefinite" for an end.
 */
export function formatDesTimeArg(seconds: number): string | null {
  if (seconds === Infinity) return 'inf';
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const micros = Math.round(seconds * 1e6);
  if (seconds > 0 && micros === 0) return null;
  const whole = Math.floor(micros / 1e6);
  const frac = micros - whole * 1e6;
  const p = (n: number): string => String(n).padStart(2, '0');
  const sec = p(whole % 60) + (frac > 0 ? `.${String(frac).padStart(6, '0').replace(/0+$/, '')}` : '');
  return `${p(Math.floor(whole / 86400))}:${p(Math.floor((whole % 86400) / 3600))}:${p(Math.floor((whole % 3600) / 60))}:${sec}`;
}

/**
 * Parse a DD:HH:MM:SS duration into seconds. Accepts 1–4 colon-separated fields
 * (SS, MM:SS, HH:MM:SS, DD:HH:MM:SS) so partial entry is forgiving. Returns null
 * for an empty or non-numeric value (the caller then leaves the value unchanged).
 */
export function parseDesDuration(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const parts = t.split(':').map((x) => x.trim());
  if (parts.length > 4) return null;
  const mult = [1, 60, 3600, 86400]; // seconds, minutes, hours, days (right-to-left)
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[parts.length - 1 - i];
    if (raw === '') return null; // empty field (e.g. partial "01:") → invalid
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    total += n * mult[i];
  }
  return total;
}

/** Format seconds to `DD:HH:MM:SS.s` (`—` for non-finite). */
export function formatSimClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const whole = Math.floor(secs);
  const tenth = Math.floor((secs - whole) * 10);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(days)}:${p(hours)}:${p(mins)}:${p(whole)}.${tenth}`;
}
