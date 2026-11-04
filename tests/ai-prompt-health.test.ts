// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  chooseAiPromptBackend,
  parseAiPromptHealth,
} from '../../realvirtual-WebViewer-Private~/src/plugins/ai-prompt/ai-prompt-health';

describe('ai-prompt-health', () => {
  it('parses independent backends and an opaque workspace key', () => {
    const health = parseAiPromptHealth({ aiPrompt: {
      available: true,
      reason: null,
      workspaceKey: 'workspace-123',
      backends: {
        claude: { available: false, reason: 'no-cli' },
        codex: { available: true, reason: null },
      },
    } });

    expect(health).toEqual({
      available: true, reason: null, workspaceKey: 'workspace-123',
      backends: {
        claude: { available: false, reason: 'no-cli' },
        codex: { available: true, reason: null },
      },
    });
    expect(chooseAiPromptBackend(health, 'claude')).toBe('codex');
  });

  it('keeps legacy health Claude-only and fails closed without a workspace key', () => {
    const health = parseAiPromptHealth({ aiPrompt: { available: true, reason: null } });
    expect(health.backends.claude.available).toBe(true);
    expect(health.backends.codex).toEqual({ available: false, reason: 'not-supported' });
    expect(health.workspaceKey).toBeNull();
  });
});
