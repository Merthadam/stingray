import type { Terminal } from '@xterm/xterm';

// Own unmodified link clicks before xterm forwards mouse reports to a fullscreen
// program (such as Pi). Otherwise both the program and host can open the link.
export function installTerminalLinks(terminal: Terminal, host: HTMLElement, open: (uri: string) => void) {
  let hovered: string | undefined;
  let pressed: { uri: string; x: number; y: number; dragged: boolean } | undefined;
  const plain = (event: MouseEvent) => event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  terminal.options.linkHandler = {
    allowNonHttpProtocols: true, // Main-process validation is mandatory for every target.
    activate: () => {}, // Capture handlers below own activation, never window.open.
    hover: (_event, uri) => { hovered = uri; host.title = 'Click to open link · Option-drag on Mac / Shift-drag elsewhere to select'; },
    leave: () => { hovered = undefined; host.removeAttribute('title'); },
  };
  const down = (event: MouseEvent) => {
    if (!hovered || !plain(event)) return;
    pressed = { uri: hovered, x: event.clientX, y: event.clientY, dragged: false };
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const move = (event: MouseEvent) => {
    if (!pressed) return;
    if (Math.abs(event.clientX - pressed.x) > 4 || Math.abs(event.clientY - pressed.y) > 4) pressed.dragged = true;
    event.stopImmediatePropagation();
  };
  const up = (event: MouseEvent) => {
    const click = pressed;
    if (!click || event.button !== 0) return;
    pressed = undefined;
    event.preventDefault(); event.stopImmediatePropagation();
    if (plain(event) && !click.dragged && hovered === click.uri && host.contains(event.target as Node) &&
        Math.abs(event.clientX - click.x) <= 4 && Math.abs(event.clientY - click.y) <= 4) open(click.uri);
  };
  const cancel = () => { pressed = undefined; };
  const resetHoverCell = (event: Event) => {
    if (event.target !== host.querySelector('.xterm-screen')) return;
    // xterm 6.0.0 clears its active link on screen leave but retains the last
    // cell, so returning to that exact cell skips hover lookup. Invalidate the
    // cell/line caches so re-entry reads current links, not a URI that changed
    // while outside (when xterm no longer watches that link's rendered row).
    // This guarded compatibility shim uses a private field in our pinned xterm
    // version. Keep the native same-cell regression when upgrading/removing it.
    const linkifier = (terminal as unknown as {
      _core?: { linkifier?: { _lastBufferCell?: unknown; _activeLine?: number } };
    })._core?.linkifier;
    if (linkifier && '_lastBufferCell' in linkifier && '_activeLine' in linkifier) {
      linkifier._lastBufferCell = undefined;
      linkifier._activeLine = -1;
    }
  };
  host.addEventListener('mouseleave', resetHoverCell, true);
  host.addEventListener('mousedown', down, true);
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  window.addEventListener('blur', cancel);
  return () => {
    host.removeEventListener('mouseleave', resetHoverCell, true);
    host.removeEventListener('mousedown', down, true);
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    window.removeEventListener('blur', cancel);
    host.removeAttribute('title');
  };
}
