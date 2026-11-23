/** Git with the repository-inventory limits. */
export interface RepoInventory {
  /** 15 s / 16 MiB; `grep` exit 1 without output is ''; other failures reject with the inventory-limit message. */
  run(root: string, args: string[]): Promise<string>;
  /** 10 s / 512 KiB raw bytes (show/diff of one file); rejects on error or limit. */
  bytes(root: string, args: string[]): Promise<Uint8Array>;
  /** 'born' when HEAD^{commit} resolves; 'unborn' when HEAD's branch ref does not exist yet; rejects when HEAD is unavailable. */
  head(root: string): Promise<'born' | 'unborn'>;
}
export interface WorkingFiles {
  realpath(path: string): Promise<string>;
  /** Symlink-safe bounded read (≤ 512 KiB) of a working-tree file; null when it does not exist; rejects with a user-facing reason. */
  read(root: string, relative: string): Promise<Uint8Array | null>;
  /** lstat of a working-tree entry, never rejects. */
  probe(root: string, relative: string): Promise<'missing' | 'emptyFile' | 'other'>;
}
