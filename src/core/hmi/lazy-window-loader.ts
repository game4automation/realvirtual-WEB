// SPDX-License-Identifier: AGPL-3.0-only
/** Share an in-flight window import; failed imports remain retryable. */
export function createLazyWindowLoader<T>(load: () => Promise<T>) {
 let pending: Promise<T> | null = null;
 return () => pending ??= load().catch(error => { pending = null; throw error; });
}
