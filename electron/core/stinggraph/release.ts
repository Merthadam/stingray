import type { GraphReleaseHost } from './ports';

export const GRAPH_RELEASE_REFUSED = 'Could not stop the code graph for this workspace. Close Stingray and try again.';

/** Blocking beforeRemove listener: the worker must not hold files in a folder being deleted. A failed close kills the
 * worker (other workspaces' graphs reopen on their next open()); only a failed kill refuses the removal. */
export async function releaseWorkspace(host: GraphReleaseHost, workspaceId: string,
  log: (message: string, error: unknown) => void = (m, e) => console.error(m, e)): Promise<void> {
  try { await host.close(workspaceId); return; } catch (error) { log('Code graph release failed; stopping the worker:', error); }
  try { await host.kill(); } catch (error) { log('Code graph worker could not be stopped:', error); throw new Error(GRAPH_RELEASE_REFUSED); }
}
