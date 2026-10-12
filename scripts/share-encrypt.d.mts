// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export const SHARE_BYTE_BUDGET: number;
export const MOBILE_WARN_BYTES: number;
export const ENVELOPE_HEADER_BYTES: number;
export const ENVELOPE_CHUNK_OVERHEAD: number;
export const DEFAULT_BASE: string;
export const DEFAULT_EXPIRY_DAYS: number;
export const FILESHARE_API_BASE: string;
export const DEFAULT_API_KEY_FILE: string;
export const MIN_PASSWORD_LENGTH: number;

export interface ShareEncryptArgs {
  input: string | null;
  out: string | null;
  upload: boolean;
  expiryDays: number;
  fileUrl: string | null;
  base: string;
  linkOnly: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ShareEncryptArgs;
export function envelopeSize(plainBytes: number, chunkSize?: number): number;
export function checkShareSize(
  envelopeBytes: number,
  plainBytes: number,
  budget?: number,
): { error?: string; warnings: string[] };
export function generatePassword(): string;
export function resolvePassword(env: Record<string, string | undefined>): { password: string; generated: boolean };
export function parseFragment(raw: string | undefined): Uint8Array;
export function encryptShare(
  plain: Uint8Array | ArrayBuffer,
  opts: { password: string; fragment: Uint8Array; iterations?: number },
): Promise<Uint8Array>;
export function fileUrlOf(shareUrl: string): string;
export function buildEncryptedShareLink(base: string, fileUrl: string, fragment: Uint8Array | string): string;
export function loadApiKey(
  env: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): string;
export function uploadToFileshare(
  file: string,
  opts: {
    apiKey: string;
    expiryDays?: number;
    fetchImpl?: typeof fetch;
    apiBase?: string;
    brand?: string;
  },
): Promise<{ url: string; fileUrl: string }>;
export function runShareEncrypt(
  argv: string[],
  io?: {
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    fetchImpl?: typeof fetch;
  },
): Promise<number>;
