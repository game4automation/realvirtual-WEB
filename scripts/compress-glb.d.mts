export const DRACO_EXTENSION: 'KHR_draco_mesh_compression';

export interface DracoOptions {
  method?: 'edgebreaker' | 'sequential';
  encodeSpeed?: number;
  decodeSpeed?: number;
  quantizePosition?: number;
  quantizeNormal?: number;
  quantizeTexcoord?: number;
  quantizeColor?: number;
  quantizeGeneric?: number;
}

export const DEFAULT_DRACO_OPTIONS: Readonly<Required<DracoOptions>>;

export interface CompressGlbOptions {
  /** Re-encode a GLB that already carries Draco (lossy on top of lossy). */
  force?: boolean;
  /** Refuse an input that already carries an `rv_sig` (default true). */
  refuseSignedInput?: boolean;
  dracoOptions?: DracoOptions;
}

export interface CompressGlbResult {
  bytes: Buffer;
  bytesBefore: number;
  bytesAfter: number;
  ratio: number;
  skipped: boolean;
  reason?: string;
}

export interface CompressGlbFileResult extends CompressGlbResult {
  path: string;
  target: string;
  written: boolean;
}

export function getIO(): Promise<import('@gltf-transform/core').NodeIO>;

export function readGlbJson(input: Uint8Array | ArrayBuffer): Record<string, unknown>;

export function hasDraco(input: Uint8Array | ArrayBuffer): boolean;

export function isSigned(input: Uint8Array | ArrayBuffer): boolean;

export function compressGlbBytes(
  input: Uint8Array | ArrayBuffer,
  options?: CompressGlbOptions,
): Promise<CompressGlbResult>;

export function compressGlbFile(
  filePath: string,
  options?: CompressGlbOptions & { out?: string; dryRun?: boolean },
): Promise<CompressGlbFileResult>;
