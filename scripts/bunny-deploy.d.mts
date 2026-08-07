export function uploadDirectory(
  client: { listRecursive(path: string): Promise<any[]>; putFile(bytes: Buffer, path: string): Promise<void>; deleteFile(path: string): Promise<void> },
  localDir: string,
  remotePrefix: string,
  options: { force: boolean; dryRun: boolean; alwaysUploadGlbs: boolean; preserveRemotePrefixes?: string[] },
): Promise<{ uploaded: number; skipped: number; deleted: number }>;
export function reconcileRemoteSnapshot(
  client: { listRecursive(path: string): Promise<any[]>; deleteFile(path: string): Promise<void> },
  remotePrefix: string,
  expectedPaths: Set<string>,
): Promise<number>;
