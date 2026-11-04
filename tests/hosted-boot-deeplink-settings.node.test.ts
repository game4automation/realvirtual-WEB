// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-2018 9.5b: the two settings generators and the deep-link rule. */
import { describe, it, expect } from 'vitest';
import { resolveHostedBoot } from '../src/core/project/rv-project-open';
import { generateHostedSettings } from '../scripts/_bunny-lib.mjs';
import { generatedSettings } from '../scripts/_workspace-lib.mjs';

const documents = [{ id: 'doc_a', path: 'models/Machine.glb', name: 'Machine' }];
const probe = (settings: { hostedDeploy?: boolean }) => resolveHostedBoot({
  servedProjectUrl: 'https://x.test/p/', servedFromQuery: true, modeLocked: false,
  hasDeployedManifest: true, documentCount: 1, documents,
  hostedDeploy: settings.hostedDeploy === true, defaultModel: 'Machine.glb',
});

describe('deep link vs. real settings generators (plan-2018 9.5b)', () => {
  it('generatedSettings() carries no marker: the query loader opens the start document', () => {
    const s = generatedSettings({ settings: { defaultModel: 'Machine.glb' }, documents },
      { connectChannel: 'stable', connectLicenseKey: '' }, null);
    expect(s.hostedDeploy).toBeUndefined();
    expect(probe(s)).toMatchObject({ kind: 'document', docId: 'doc_a', deepLink: true });
  });
  it('generateHostedSettings() carries the marker: the dashboard stays (D14)', () => {
    const s = JSON.parse(generateHostedSettings({}));
    expect(s.hostedDeploy).toBe(true);
    expect(probe(s)).toEqual({ kind: 'dashboard' });
  });
});
