// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `validate-project.mjs`.
 *
 * Required because the Node tests import the module statically from TypeScript;
 * without it `npx tsc --noEmit` fails with TS7016. Keep in step with the .mjs —
 * there is no compiler check tying the two together.
 */

export interface ProjectValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateProject(root: string): ProjectValidationResult;
export function assertValidProject(root: string, label?: string): ProjectValidationResult;
