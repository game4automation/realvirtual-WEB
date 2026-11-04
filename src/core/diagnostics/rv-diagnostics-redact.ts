// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

const REDACTED = '[redacted]';

/** Remove credentials from arbitrary diagnostic text without changing surrounding context. */
export function redactDiagnosticsText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[^\s,;"']+/gi, `$1 ${REDACTED}`)
    .replace(/\b(X-Api-Key\s*:\s*)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(/(["']?(?:apiKey|devkey|password|passwd|pwd|licenseKey|licenceKey|license)["']?\s*[:=]\s*["']?)([^\s,;"'&}]+)/gi, `$1${REDACTED}`)
    .replace(/(#k=)[^&#\s]*/gi, `$1${REDACTED}`);
}

/** Strip fragments and redact secret query parameters before a URL is logged. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:apiKey|devkey|password|passwd|pwd|licenseKey|licenceKey|license)$/i.test(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return redactDiagnosticsText(url.replace(/#.*$/, ''));
  }
}
