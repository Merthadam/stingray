import type { DesktopAPI } from '../shared/contracts';
import { pickApi } from './app/pick-api';

declare global { interface Window { stingray?: DesktopAPI } }
export const api: DesktopAPI = await pickApi({
  bridge: window.stingray, userAgent: navigator.userAgent, search: location.search, dev: import.meta.env.DEV,
  loadDemo: async () => (await import('./demo')).demoAPI,
});
