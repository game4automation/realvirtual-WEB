// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Pins the vocabulary consolidation of plan-341 Phase 6.
 *
 * The point is not the exact strings — those may be reworded — but that the
 * surfaces keep reading them from ONE record. Before this, the element-state
 * labels existed twice (3D badge sprite + popover header) as byte-identical
 * literals, and the authority sentences existed in three phrasings across the
 * slot-row tooltip and the signal-badge note.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_CONSEQUENCE,
  AUTHORITY_SENTENCE,
  BINDING_STATE_LABEL,
  NOT_LINKED_CELL,
  NOT_LINKED_LABEL,
  authorityExplanation,
} from '../src/core/hmi/signal-vocabulary';
import { SIGNAL_BADGE_STATE_LABEL } from '../src/plugins/signal-bind/SignalBadgeController';
import { AUTHORITY_REASON_TEXT } from '../src/core/hmi/rv-signal-slot-row';

describe('signal vocabulary — one source per fact', () => {
  it('the 3D badge sprite label IS the shared element-state record', () => {
    // Identity, not equality: a copy would drift, an alias cannot.
    expect(SIGNAL_BADGE_STATE_LABEL).toBe(BINDING_STATE_LABEL);
  });

  it('every element state has a label and "unbound" reuses the not-linked lexeme', () => {
    for (const state of ['unbound', 'live', 'pending', 'disconnected', 'conflict'] as const) {
      expect(BINDING_STATE_LABEL[state].length).toBeGreaterThan(0);
    }
    expect(BINDING_STATE_LABEL.unbound).toBe(NOT_LINKED_LABEL);
    // Same words, different sentence position — the cell is not a sentence.
    expect(NOT_LINKED_CELL.toLowerCase()).toContain(NOT_LINKED_LABEL.toLowerCase());
  });

  it('the slot-row tooltip is the authority sentence plus its consequence', () => {
    expect(AUTHORITY_REASON_TEXT['ok']).toBe(AUTHORITY_SENTENCE.ok);
    for (const key of ['bound', 'forced', 'remote'] as const) {
      const long = AUTHORITY_REASON_TEXT[`authority-${key}`];
      expect(long).toBe(authorityExplanation(key));
      // The compact badge note is a PREFIX of the roomy tooltip, so shortening
      // can never turn into rewording.
      expect(long.startsWith(AUTHORITY_SENTENCE[key])).toBe(true);
      expect(long).toContain(AUTHORITY_CONSEQUENCE[key]);
    }
  });

  it('no authority sentence names CONNECT — an internal relay is bound too', () => {
    for (const sentence of Object.values(AUTHORITY_SENTENCE)) {
      expect(sentence).not.toContain('CONNECT');
    }
  });
});
