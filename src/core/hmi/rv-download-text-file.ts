// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-download-text-file.ts — hand a text to the browser as a file download (plan-501 F7).
 *
 * Extracted from `downloadSettingsBundle()` so every "save this text as a file" goes through one
 * place: the settings bundle (JSON) and the mechanism drive-sizing export (SERVOsoft axis files,
 * Tab + CRLF + decimal comma) both use it.
 *
 * The text is written VERBATIM as UTF-8 without a byte-order mark — `Blob` encodes a JS string as
 * UTF-8 and adds no BOM, and line ends are whatever the caller put in (the SERVOsoft files need
 * CRLF and carry it themselves).
 */

/** Download `text` as `filename`. Browser-only; a no-op outside a DOM. */
export function downloadTextFile(text: string, filename: string, mimeType = 'text/plain;charset=utf-8'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
