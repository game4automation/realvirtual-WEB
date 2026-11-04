// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DESSnapshotV4 } from './rv-des-snapshot-v4';

export interface HookPayloadContext {
  raw?: DESSnapshotV4;
  componentId: string | null;
  eventId: number;
  time: number;
}
export interface HookPayloadCodec {
  encode(value: unknown): { value: unknown } | undefined;
  decode(value: unknown, context: HookPayloadContext): { value: unknown } | undefined;
}
const codecs = new Map<string, HookPayloadCodec>();
export function registerHookPayloadCodec(key: string, codec: HookPayloadCodec): void {
  codecs.set(key, codec);
}
export function encodeHookPayload(value: unknown): { value: unknown } | undefined {
  for (const codec of codecs.values()) {
    const encoded = codec.encode(value);
    if (encoded) return encoded;
  }
}
export function decodeHookPayload(value: unknown, context: HookPayloadContext): unknown {
  for (const codec of codecs.values()) {
    const decoded = codec.decode(value, context);
    if (decoded) return decoded.value;
  }
  return value;
}
