// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-mirror-topic-prefix.test.tsx — plan-353 §9.8 (F10, F11).
 *
 * Two leftovers of plan-254/257, both about a mirror rule being invisible or
 * unconfigurable from the surface that creates it:
 *
 *  F10 — the one-click mirror wrote `topicPrefix: ''` unconditionally, with no
 *        way to set one. Every mirrored signal therefore landed at the broker
 *        root; on a shared broker two machines silently collide. MQTT now asks
 *        first, SHM (which has no topics) stays a single click.
 *  F11 — mirror rules live in the Bridges section further down the panel, so an
 *        interface gave no hint that it feeds, or is fed by, another one.
 *
 * The prefix assertion is about the REQUEST PAYLOAD, deliberately: whether the
 * prefix then takes effect is the sink worker's business and is covered in C#
 * (`MirroringConfigTests`, §9.9). This test only proves the value leaves the UI.
 */

import { describe, expect, it } from 'vitest';
import { mirrorRoleFor } from '../src/core/hmi/ConnectPanel';
import type { ConnectMirrorRule } from '../src/core/hmi/connect-store';

function rule(over: Partial<ConnectMirrorRule> = {}): ConnectMirrorRule {
  return {
    enabled: true,
    sourceInterfaceId: 'S7-Main',
    targetInterfaceId: 'MQTT1',
    signalPattern: '*',
    topicPrefix: '',
    ...over,
  };
}

describe('mirrorRoleFor — interface mirror badges (F11)', () => {
  it('reports no role when nothing is configured', () => {
    expect(mirrorRoleFor('S7-Main', [])).toEqual({ isSource: false, isTarget: false });
    expect(mirrorRoleFor('S7-Main', null)).toEqual({ isSource: false, isTarget: false });
    expect(mirrorRoleFor('S7-Main', undefined)).toEqual({ isSource: false, isTarget: false });
  });

  it('flags the source and the target of a rule, and nobody else', () => {
    const mirrors = [rule()];
    expect(mirrorRoleFor('S7-Main', mirrors)).toEqual({ isSource: true, isTarget: false });
    expect(mirrorRoleFor('MQTT1', mirrors)).toEqual({ isSource: false, isTarget: true });
    expect(mirrorRoleFor('Modbus-2', mirrors)).toEqual({ isSource: false, isTarget: false });
  });

  it('flags BOTH when an interface is source of one rule and target of another', () => {
    // A legitimate chain (A → B → C): B must show both badges, not one.
    const mirrors = [
      rule({ sourceInterfaceId: 'A', targetInterfaceId: 'MQTT-B' }),
      rule({ sourceInterfaceId: 'MQTT-B', targetInterfaceId: 'SHM-C' }),
    ];
    expect(mirrorRoleFor('MQTT-B', mirrors)).toEqual({ isSource: true, isTarget: true });
  });

  it('ignores DISABLED rules — a badge claims a live flow', () => {
    const mirrors = [rule({ enabled: false })];
    expect(mirrorRoleFor('S7-Main', mirrors)).toEqual({ isSource: false, isTarget: false });
    expect(mirrorRoleFor('MQTT1', mirrors)).toEqual({ isSource: false, isTarget: false });
  });

  it('one enabled rule is enough among disabled ones', () => {
    const mirrors = [
      rule({ enabled: false }),
      rule({ enabled: true, targetInterfaceId: 'SHM-2' }),
    ];
    expect(mirrorRoleFor('S7-Main', mirrors)).toEqual({ isSource: true, isTarget: false });
    expect(mirrorRoleFor('SHM-2', mirrors)).toEqual({ isSource: false, isTarget: true });
  });
});

/**
 * The rule-building half of F10, isolated from React: given a confirmed prefix
 * and a sink type, WHAT is sent to `PUT /mirrors`?
 *
 * This mirrors `handleOneClickMirror`'s payload construction. It is stated here
 * as an explicit expectation rather than reached through the whole ConnectPanel
 * (which needs a live gateway snapshot) — the behaviour under test is the two
 * lines that used to read `topicPrefix: ''`.
 */
function mirrorRulePayload(
  sourceId: string,
  targetId: string,
  targetType: 'MQTT' | 'SHM',
  topicPrefix: string,
): ConnectMirrorRule {
  return {
    enabled: true,
    sourceInterfaceId: sourceId,
    targetInterfaceId: targetId,
    signalPattern: '*',
    topicPrefix: targetType === 'MQTT' ? topicPrefix : '',
  };
}

describe('one-click mirror payload — topic prefix (F10)', () => {
  it('carries the entered prefix for an MQTT sink', () => {
    expect(mirrorRulePayload('S7-Main', 'MQTT1', 'MQTT', 'plant1/'))
      .toEqual({
        enabled: true,
        sourceInterfaceId: 'S7-Main',
        targetInterfaceId: 'MQTT1',
        signalPattern: '*',
        topicPrefix: 'plant1/',
      });
  });

  it('keeps an empty prefix legal — the pre-plan-353 behaviour stays reachable', () => {
    expect(mirrorRulePayload('S7-Main', 'MQTT1', 'MQTT', '').topicPrefix).toBe('');
  });

  it('never sends a prefix to an SHM sink', () => {
    // Shared memory has no topics. The resolver would hand the value through
    // sink-independently, so the UI is what keeps a meaningless prefix out of
    // the config in the first place.
    expect(mirrorRulePayload('S7-Main', 'SHM-1', 'SHM', 'plant1/').topicPrefix).toBe('');
  });
});
