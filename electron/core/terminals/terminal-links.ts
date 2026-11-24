import { extname } from '../shared/posix-path';
import type { LinkActions, LinkTargets } from './ports';

export type TerminalLink = { kind: 'web' | 'file' | 'reveal'; target: string };
const invalid = () => new Error('Use an HTTP(S) link without credentials or a local path inside this terminal’s workspace.');
const unsafeText = /[\x00-\x1f\x7f\\\u202a-\u202e\u2066-\u2069]/;
// Never send arbitrary executables, scripts, HTML, SVG or application bundles to
// the OS default handler. Unknown types are revealed in the file manager only.
const readableTypes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.md', '.markdown', '.log', '.json', '.csv']);

export async function resolveTerminalLink(input: string, workspace: string, targets: LinkTargets): Promise<TerminalLink> {
  if (!input || input.length > 8192 || input !== input.trim() || unsafeText.test(input) || input.startsWith('//')) throw invalid();
  let url: URL;
  try {
    if (unsafeText.test(decodeURIComponent(input))) throw invalid();
    url = targets.resolveUrl(input, workspace);
  } catch { throw invalid(); }
  if (url.username || url.password) throw invalid();
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!/^https?:\/\//i.test(input) || !url.hostname) throw invalid();
    return { kind: 'web', target: url.href };
  }
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw invalid();
  let real: { target: string; inside: boolean };
  try { real = await targets.realTarget(url, workspace); } catch { throw new Error('The linked local file is unavailable.'); }
  if (!real.inside) throw invalid();
  let info;
  try { info = await targets.stat(real.target); } catch { throw new Error('The linked local file is unavailable.'); }
  if (!info.isFile && !info.isDirectory) throw new Error('Only regular files and folders can be opened.');
  const readable = info.isFile && !(info.mode & 0o111) && readableTypes.has(extname(real.target).toLowerCase());
  return { kind: readable ? 'file' : 'reveal', target: real.target };
}

export type TerminalLinkActions = LinkActions;

export async function openTerminalLink(input: string, workspace: string, actions: LinkActions, targets: LinkTargets): Promise<void> {
  const link = await resolveTerminalLink(input, workspace, targets);
  if (!await actions.confirm(link)) return;
  // Revalidate after the dialog: do not follow a replaced symlink or silently
  // switch from opening a document to launching a newly executable file.
  const current = await resolveTerminalLink(input, workspace, targets);
  if (current.kind !== link.kind || current.target !== link.target) throw new Error('The link changed while awaiting confirmation. Click it again.');
  try {
    if (link.kind === 'web') await actions.openExternal(link.target);
    else if (link.kind === 'reveal') actions.showItemInFolder(link.target);
    else if (await actions.openPath(link.target)) throw new Error('Open failed.');
  } catch { throw new Error('The system could not open this link.'); }
}
