// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { formatDesDuration, parseDesDuration } from '../../src/plugins/sim-controller/DESControllerToolbar';
import { formatSimClock } from '../../src/plugins/sim-controller/format-sim-time';

describe('DES clock DD:HH:MM:SS format/parse', () => {
  it('formats seconds as DD:HH:MM:SS (no tenths)', () => {
    expect(formatDesDuration(86400)).toBe('01:00:00:00'); // 1 day
    expect(formatDesDuration(3661)).toBe('00:01:01:01');   // 1h 1m 1s
    expect(formatDesDuration(0)).toBe('');                  // 0 / off → empty
    expect(formatDesDuration(Infinity)).toBe('');           // infinite → empty
  });

  it('parses 1–4 colon-separated fields (forgiving partial entry)', () => {
    expect(parseDesDuration('01:00:00:00')).toBe(86400);
    expect(parseDesDuration('00:01:01:01')).toBe(3661);
    expect(parseDesDuration('01:30')).toBe(90);   // MM:SS
    expect(parseDesDuration('45')).toBe(45);       // SS only
    expect(parseDesDuration('02:00:00')).toBe(7200); // HH:MM:SS
  });

  it('returns null for empty / non-numeric input (leave value unchanged)', () => {
    expect(parseDesDuration('')).toBeNull();
    expect(parseDesDuration('  ')).toBeNull();
    expect(parseDesDuration('01:')).toBeNull();      // trailing empty field
    expect(parseDesDuration('ab:cd')).toBeNull();
    expect(parseDesDuration('1:2:3:4:5')).toBeNull(); // > 4 fields
  });

  it('round-trips format → parse', () => {
    for (const s of [0, 45, 3661, 86400, 90061]) {
      const str = formatDesDuration(s);
      if (str === '') { expect(s).toBe(0); continue; }
      expect(parseDesDuration(str)).toBe(s);
    }
  });
});

describe('formatSimClock — toolbar clock display (DD:HH:MM:SS.s)', () => {
  it('renders the sim time with a tenths digit', () => {
    expect(formatSimClock(0)).toBe('00:00:00:00.0');
    expect(formatSimClock(3661.5)).toBe('00:01:01:01.5');
    expect(formatSimClock(90061.5)).toBe('01:01:01:01.5');
  });
  it('renders — for non-finite (infinite end)', () => {
    expect(formatSimClock(Infinity)).toBe('—');
  });
});
