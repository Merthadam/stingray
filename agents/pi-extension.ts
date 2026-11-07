import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPiObserver, type PiObserverAPI } from './pi-observer';

export default function stingrayActivity(pi: ExtensionAPI) {
  registerPiObserver(pi as unknown as PiObserverAPI, VERSION);
}
