import { fileURLToPath } from 'node:url';
import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPiObserver, type PiObserverAPI } from './pi-observer';

// Bundled to dist-electron/pi-extension.js; the build copies agents/skills to dist-electron/skills.
const skills = fileURLToPath(new URL('./skills', import.meta.url));

export default function stingrayActivity(pi: ExtensionAPI) {
  registerPiObserver(pi as unknown as PiObserverAPI, VERSION);
  pi.on('resources_discover', () => ({ skillPaths: [skills] }));
}
