import { session } from 'electron';

const locked = new Set<string>();
/** Webview partitions: no permissions, no downloads. */
export function lockSession(partition: string) {
  if (locked.has(partition)) return;
  locked.add(partition);
  const guest = session.fromPartition(partition);
  guest.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guest.setPermissionCheckHandler(() => false);
  guest.on('will-download', event => event.preventDefault());
}
/** Audit 20: cookies, storage and cache of a removed workspace's browser pane. */
export async function clearWorkspaceSession(workspaceId: string) {
  const partition = 'persist:stingray-' + workspaceId;
  const guest = session.fromPartition(partition);
  await guest.clearStorageData();
  await guest.clearCache();
  locked.delete(partition);
}
