// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * format-sim-time.ts — shared sim-clock formatter for the sim-control toolbars
 * (continuous planner clock + DES clock). DD:HH:MM:SS with a tenths digit on the
 * seconds so sub-second progress is visible, mirroring the C# DESManager time.
 */

/** Format seconds to an editable DD:HH:MM:SS string (no tenths) for inputs. */
export function formatDesDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const s = Math.floor(totalSeconds);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 86400))}:${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
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
