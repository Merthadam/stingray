// Per-user Views state (hidden nodes, positions, expansions) per worktree and view, in the `view_state` table of the
// app database. Never written to the repo. Rows go with their workspace (ON DELETE CASCADE).
export const MAX_VIEW_STATES = 200, MAX_VIEW_STATE_BYTES = 5 * 1024 * 1024;
