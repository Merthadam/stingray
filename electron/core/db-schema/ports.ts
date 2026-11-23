/** Worktree files for the schema scanners: the one walker with dot-dirs skipped and the 20 000 entry cap. */
export interface SchemaFiles {
  /** Sorted kept files (≤ 5 000); rejects when the root is unreadable; unreadable subdirectories go to onDirError. */
  list(root: string, keep: (rel: string) => boolean, onDirError: (rel: string, error: Error) => void): Promise<{ files: string[]; truncated: boolean }>;
  /** Text of a regular file ≤ 1 MiB, opened without following symlinks; rejects with the fs error. */
  read(root: string, rel: string): Promise<{ text: string } | { skipped: 'notFile' | 'tooLarge' }>;
}
