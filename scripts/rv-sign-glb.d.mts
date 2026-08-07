import type { KeyObject } from 'node:crypto';

export const RV_SIG_PLACEHOLDER: string;
export const RV_SIG_ROOT_PUBLIC_KEY_BASE64: string;

export interface RvCustomerCertificate {
  pub: string;
  org: string;
  sig: string;
}

export interface RvSigningConfig {
  privateKey: KeyObject;
  customerCert: RvCustomerCertificate | null;
}

export function getDefaultSceneExtras(
  json: Record<string, unknown>,
  create?: boolean,
): Record<string, unknown> | null;

export function loadSigningConfig(
  env?: Record<string, string | undefined>,
  rootPublicKey?: Uint8Array,
): RvSigningConfig | null;

export function signGlbBytes(
  input: Uint8Array | ArrayBuffer,
  signing: RvSigningConfig,
): Buffer;

export function verifyGlbBytes(
  input: Uint8Array | ArrayBuffer,
  rootPublicKey?: Uint8Array,
): 'none' | 'valid' | 'invalid';

export function signGlbFile(filePath: string, signing: RvSigningConfig): Buffer;
