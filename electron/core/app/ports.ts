export interface EditorDeps {
  env: { PATH?: string; HOME?: string };
  isExecutable(file: string): Promise<boolean>;
  /** Run a CLI without a shell; rejects when it cannot start or exits non-zero. */
  launch(file: string, args: string[]): Promise<void>;
  showItemInFolder(file: string): void;
  /** Absolute real path of a regular file inside the worktree; rejects with "Choose a regular file inside this worktree." / "The file is unavailable.". */
  resolveSource(root: string, file: string): Promise<string>;
}
