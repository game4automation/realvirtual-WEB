// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  CONNECT_INTERFACE_TYPES,
  CTRLXDATALAYER_SETTINGS_DEFAULTS,
} from '../src/core/hmi/connect-store';

describe('ctrlX Data Layer interface defaults', () => {
  it('matches the CONNECT CtrlXDataLayerSettings POCO defaults', () => {
    expect(CTRLXDATALAYER_SETTINGS_DEFAULTS).toEqual({
      address: '',
      port: 443,
      username: null,
      password: null,
      allowUntrustedCertificate: false,
      useStatelessSubscription: false,
      publishIntervalMs: 100,
      keepaliveIntervalMs: 60000,
      errorIntervalMs: 10000,
      samplingIntervalUs: 0,
      queueSize: 100,
      queueBehaviour: 'DiscardOldest',
      valueChange: 'StatusValue',
      browseRootPaths: [],
      maxSubscriptionNodes: 500,
      stableConnectionSec: 30,
      tokenTtlMinutes: 10,
    });
  });

  it('registers the native type separately from the ctrlX tunnel fallback', () => {
    const native = CONNECT_INTERFACE_TYPES.find(({ type }) => type === 'CtrlXDataLayer');
    const tunnel = CONNECT_INTERFACE_TYPES.find(({ type }) => type === 'CtrlX');

    expect(native?.defaults).toEqual({
      ctrlXDataLayer: CTRLXDATALAYER_SETTINGS_DEFAULTS,
    });
    expect(native?.type).not.toBe(tunnel?.type);
  });
});
