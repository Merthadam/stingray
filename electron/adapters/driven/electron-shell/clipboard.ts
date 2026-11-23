import { clipboard } from 'electron';
import type { Clipboard } from '../../../core/runtime';

export const electronClipboard: Clipboard = { writeText: text => clipboard.writeText(text) };
