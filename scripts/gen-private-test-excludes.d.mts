// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Import specifiers that need a private sibling repo to resolve. */
export function isPrivateSpecifier(spec: string): boolean;

/** Sorted repo-relative list of test files that import private-only modules. */
export function computePrivateDependentTests(root?: string): string[];
