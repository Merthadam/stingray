import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInfo, TerminalEvent } from './shared';
import { api } from './api';
import { installTerminalLinks } from './terminal-links';

export function TerminalPane({ info, visible, onError, onObserve }: { info: TerminalInfo; visible: boolean; onError: (message: string) => void; onObserve: (id: string, stillObserved: () => boolean) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const observeRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const onObserveRef = useRef(onObserve); onObserveRef.current = onObserve;
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    // Start at the PTY's size, not xterm's 80x24 default: a pane mounted hidden (background tab/workspace)
    // cannot be fitted, and output written into a grid of a different size than the PTY garbles TUIs.
    const terminal = new Terminal({
      cols: info.cols ?? 80, rows: info.rows ?? 24,
      cursorBlink: true, fontSize: 13, lineHeight: 1.3, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      scrollback: 3000, allowProposedApi: false, macOptionClickForcesSelection: true,
      theme: { background: '#151110', foreground: '#eae8e6', cursor: '#e07850', selectionBackground: '#e0785040',
        black: '#151110', red: '#dc6b6b', green: '#7ec699', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#eae8e6',
        brightBlack: '#a8a5a3', brightRed: '#e88888', brightGreen: '#98d1a8', brightYellow: '#ecd08f', brightBlue: '#7ec0f5', brightMagenta: '#d494e6', brightCyan: '#73c7d3', brightWhite: '#ffffff' },
    });
    const removeLinks = installTerminalLinks(terminal, element.current!, uri => {
      void api.openTerminalLink(info.id, uri).catch(e => errorRef.current(e.message));
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current!);
    let fitted = false;
    const fitNow = () => {
      if (disposed || !element.current?.clientWidth || !element.current?.clientHeight) return;
      const dims = fit.proposeDimensions();
      // Unmeasurable (e.g. fonts/renderer not ready): keep xterm and the PTY at their shared size.
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const cols = Math.min(500, Math.max(2, dims.cols)), rows = Math.min(300, Math.max(1, dims.rows));
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
      fitted = true;
      void api.resizeTerminal(info.id, cols, rows).catch(e => errorRef.current(e.message));
    };
    // Reflow once the layout settles. Panel animations, drags and returning to a workspace otherwise resize
    // the PTY many times in a row; each resize makes TUIs (pi) redraw while output for the previous width is
    // still arriving, and xterm reflows every intermediate width, which garbles the screen.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitNow, 120); };
    fitRef.current = scheduleFit;
    let disposed = false;
    const observer = new ResizeObserver(scheduleFit); observer.observe(element.current!);
    void document.fonts?.ready.then(scheduleFit);
    const input = terminal.onData(data => { void api.writeTerminal(info.id, data).catch(e => errorRef.current(e.message)); });
    let ready = false;
    let sequence = 0;
    let pendingWrites = 0;
    let rendered = false;
    const observed = () => !disposed && ready && rendered && !pendingWrites && visibleRef.current &&
      Boolean(element.current?.clientWidth && element.current?.clientHeight) &&
      terminal.buffer.active.viewportY === terminal.buffer.active.baseY;
    const observe = () => onObserveRef.current(info.id, observed);
    observeRef.current = observe;
    const write = (data: string, initial = false) => {
      ++pendingWrites;
      terminal.write(data, () => { --pendingWrites; if (initial) requestAnimationFrame(observe); });
    };
    const render = terminal.onRender(() => { rendered = true; });
    // Only view/focus/user actions acknowledge. Output and activity snapshots do not.
    const host = element.current!;
    const interaction = () => observe();
    for (const name of ['focusin', 'pointerup', 'keyup', 'wheel']) host.addEventListener(name, interaction);
    window.addEventListener('focus', interaction);
    const pending: TerminalEvent[] = [];
    const consume = (event: TerminalEvent) => {
      if (event.data && (event.sequence ?? 0) > sequence) { write(event.data); sequence = event.sequence!; }
      if (event.exitCode !== undefined) terminal.write('\\r\\n[Process exited: ' + event.exitCode + ']\\r\\n');
    };
    const off = api.onTerminal(event => {
      if (event.id !== info.id) return;
      if (ready) consume(event); else pending.push(event);
    });
    void api.terminals().then(items => {
      if (disposed) return;
      const snapshot = items.find(t => t.id === info.id) ?? info;
      // Not fitted yet (hidden): replay and render at the PTY's current size.
      if (!fitted && snapshot.cols && snapshot.rows && (snapshot.cols !== terminal.cols || snapshot.rows !== terminal.rows)) terminal.resize(snapshot.cols, snapshot.rows);
      write(snapshot.buffer, true); sequence = snapshot.sequence; ready = true;
      pending.forEach(consume); pending.length = 0;
    }).catch(e => { if (!disposed) errorRef.current(e.message); });
    fitNow();
    return () => {
      disposed = true; removeLinks();
      for (const name of ['focusin', 'pointerup', 'keyup', 'wheel']) host.removeEventListener(name, interaction);
      window.removeEventListener('focus', interaction);
      clearTimeout(fitTimer); observer.disconnect(); input.dispose(); render.dispose(); off(); terminal.dispose();
    };
  }, [info.id]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => { fitRef.current(); observeRef.current(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return <div className="terminal-surface" style={{ display: visible ? 'block' : 'none' }} ref={element} role="region" aria-label={info.title + (api.mode === 'demo' ? ' (simulated)' : '')} />;
}
