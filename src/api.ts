import type { DesktopAPI } from './shared';
export const api: DesktopAPI = window.stingray ?? (await import('./demo')).demoAPI;
