import { api } from '../../app/api';
import { createTerminalEvents } from './terminal-events';
export const terminalEvents = createTerminalEvents(listener => api.onTerminal(listener));
