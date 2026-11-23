import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { terminalScrollback, type TerminalInfo, type TerminalEvent } from './shared';
import { api } from './api';
import { installTerminalLinks } from './terminal-links';

const exitMessage = (code: number) => '\r\n[Process exited: ' + code + ']\r\n';
/** How far each disposed pane was scrolled back, so returning to a project restores the reading position. */
const scrolledBack = new Map<string, number>();
/** Panes use the DOM renderer: WebGL drew regular glyphs tiny inside full-size cells on macOS (italic was fine).
 * `localStorage['stingray.terminalRenderer'] = 'webgl'` opts back in. */
const domRenderer = () => { try { return localStorage.getItem('stingray.terminalRenderer') !== 'webgl'; } catch { return true; } };

export function TerminalPane({ info, visible, onError, onObserve }: { info: TerminalInfo; visible: boolean; onError: (message: string) => void; onObserve: (id: string, stillObserved: () => boolean) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const observeRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const onObserveRef = useRef(onObserve); onObserveRef.current = onObserve;
  const errorRef = useRef(onError); errorRef.current = onError;
  const rendererRef = useRef({ attach: () => {}, detach: () => {} });
  useEffect(() => {
    // Start at the PTY's size, not xterm's 80x24 default: a pane mounted hidden (background tab/workspace)
    // cannot be fitted, and output written into a grid of a different size than the PTY garbles TUIs.
    const terminal = new Terminal({
      cols: info.cols ?? 80, rows: info.rows ?? 24,
      cursorBlink: true, fontSize: 15, lineHeight: 1.25, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      scrollback: terminalScrollback, allowProposedApi: true, macOptionClickForcesSelection: true,
      theme: { background: '#151110', foreground: '#eae8e6', cursor: '#e07850', selectionBackground: '#e0785040',
        black: '#151110', red: '#dc6b6b', green: '#7ec699', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#eae8e6',
        brightBlack: '#a8a5a3', brightRed: '#e88888', brightGreen: '#98d1a8', brightYellow: '#ecd08f', brightBlue: '#7ec0f5', brightMagenta: '#d494e6', brightCyan: '#73c7d3', brightWhite: '#ffffff' },
    });
    const removeLinks = installTerminalLinks(terminal, element.current!, uri => {
      void api.openTerminalLink(info.id, uri).catch(e => errorRef.current(e.message));
    });
    // Emoji and other wide glyphs take two cells, as in Pi and modern terminals; xterm's default (Unicode 6)
    // counts them as one, which shifts every TUI line that contains them.
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current!);
    // WebGL draws box-drawing glyphs seamlessly and keeps up with fast TUIs. Only visible panes hold a context
    // (browsers cap them); after repeated context losses the pane stays on the DOM renderer.
    let webgl: WebglAddon | undefined, losses = 0;
    const detach = () => { webgl?.dispose(); webgl = undefined; };
    const attach = () => {
      if (webgl || disposed || losses >= 3 || domRenderer()) return;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => { losses++; detach(); });
        terminal.loadAddon(webgl);
        // The glyph atlas is shared between panes and may hold glyphs rasterized at another scale or font.
        redrawGlyphs();
      } catch { losses = 3; webgl = undefined; }
    };
    // WebGL caches each glyph once. Glyphs cached before a display-scale change (moving the window between
    // screens, sleep/wake) or before the font finished loading keep their old size: regular text then shows
    // tiny letters spread over full-size cells while newly drawn (e.g. italic) text looks right.
    const redrawGlyphs = () => {
      if (disposed || !webgl) return;
      terminal.clearTextureAtlas(); terminal.refresh(0, terminal.rows - 1);
    };
    let scaleQuery: MediaQueryList | undefined;
    const watchScale = () => {
      scaleQuery?.removeEventListener('change', onScale);
      scaleQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      scaleQuery.addEventListener('change', onScale);
    };
    const onScale = () => { watchScale(); redrawGlyphs(); scheduleFit(); };
    watchScale();
    const onFonts = () => { redrawGlyphs(); scheduleFit(); };
    document.fonts?.addEventListener('loadingdone', onFonts);
    window.addEventListener('focus', redrawGlyphs);
    rendererRef.current = { attach, detach };
    const fitNow = () => {
      // Never before the snapshot is parsed: it was serialized at the PTY's size.
      if (disposed || !ready || !visibleRef.current || !element.current?.clientWidth || !element.current?.clientHeight) return;
      const dims = fit.proposeDimensions();
      // Unmeasurable (e.g. fonts/renderer not ready): keep xterm and the PTY at their shared size.
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const cols = Math.min(500, Math.max(2, dims.cols)), rows = Math.min(300, Math.max(1, dims.rows));
      if (cols !== terminal.cols || rows !== terminal.rows) { terminal.resize(cols, rows); terminal.refresh(0, rows - 1); }
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
    let exitShown = false;
    const showExit = (code: number) => { if (!exitShown) { exitShown = true; terminal.write(exitMessage(code)); } };
    const consume = (event: TerminalEvent) => {
      if (event.data && (event.sequence ?? 0) > sequence) { write(event.data); sequence = event.sequence!; }
      if (event.exitCode !== undefined) showExit(event.exitCode);
    };
    const off = api.onTerminal(event => {
      if (event.id !== info.id) return;
      if (ready) consume(event); else pending.push(event);
    });
    // Restore the main-process mirror (screen, scrollback, alternate screen and input modes) at the PTY's size,
    // then apply newer output and only then fit, so nothing is parsed into a grid of another size.
    void api.terminalSnapshot(info.id).then(snapshot => {
      if (disposed) return;
      if (snapshot.cols !== terminal.cols || snapshot.rows !== terminal.rows) terminal.resize(snapshot.cols, snapshot.rows);
      sequence = snapshot.sequence;
      write(snapshot.data, true);
      if (snapshot.exitCode !== undefined) showExit(snapshot.exitCode);
      terminal.write('', () => {
        if (disposed) return;
        ready = true;
        pending.forEach(consume); pending.length = 0;
        const back = scrolledBack.get(info.id); scrolledBack.delete(info.id);
        if (back && terminal.buffer.active.type === 'normal') terminal.scrollLines(-back);
        fitNow();
      });
    }).catch(e => { if (!disposed) errorRef.current(e.message); });
    return () => {
      const buffer = terminal.buffer.active;
      if (ready && buffer.type === 'normal' && buffer.baseY > buffer.viewportY) scrolledBack.set(info.id, buffer.baseY - buffer.viewportY);
      disposed = true; removeLinks(); detach();
      for (const name of ['focusin', 'pointerup', 'keyup', 'wheel']) host.removeEventListener(name, interaction);
      window.removeEventListener('focus', interaction);
      window.removeEventListener('focus', redrawGlyphs); scaleQuery?.removeEventListener('change', onScale);
      document.fonts?.removeEventListener('loadingdone', onFonts);
      clearTimeout(fitTimer); observer.disconnect(); input.dispose(); render.dispose(); off(); terminal.dispose();
    };
  }, [info.id]);
  useEffect(() => {
    if (!visible) { rendererRef.current.detach(); return; }
    rendererRef.current.attach();
    const frame = requestAnimationFrame(() => { fitRef.current(); observeRef.current(); });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return <div className="terminal-surface" style={{ display: visible ? 'block' : 'none' }} ref={element} role="region" aria-label={info.title + (api.mode === 'demo' ? ' (simulated)' : '')} />;
}
