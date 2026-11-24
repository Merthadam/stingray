// Live view of a Stingray test instance over CDP: pure helpers for LiveView.tsx (the input schema is in shared/contracts/runtime).
import type { LiveViewInput } from '../../../shared/contracts/runtime';

export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
export const modifierBits = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? MODIFIER.alt : 0) | (e.ctrlKey ? MODIFIER.ctrl : 0) | (e.metaKey ? MODIFIER.meta : 0) | (e.shiftKey ? MODIFIER.shift : 0);

/** Pointer position on an `object-fit: contain` image, normalized to the frame; null in the letterbox bars. */
export function framePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number }): { x: number; y: number } | null {
  if (!frame.width || !frame.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale, height = frame.height * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width, y = (clientY - box.top - (box.height - height) / 2) / height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

/** Key event for the remote page: printable text only without Ctrl/Meta (those are shortcuts), Enter types a newline. */
export function keyInput(action: 'keyDown' | 'keyUp', e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): LiveViewInput | null {
  if (!e.key || e.key.length > 32 || e.key === 'Unidentified' || e.code.length > 32) return null;
  const mods = modifierBits(e);
  const text = action === 'keyUp' || mods & (MODIFIER.ctrl | MODIFIER.meta) ? undefined : e.key === 'Enter' ? '\r' : [...e.key].length === 1 ? e.key : undefined;
  return { type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode & 255, modifiers: mods, ...(text ? { text } : {}) };
}
