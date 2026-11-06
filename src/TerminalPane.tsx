import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInfo, TerminalEvent } from './shared';
import { api } from './api';

export function TerminalPane({ info, visible, onError }: { info: TerminalInfo; visible: boolean; onError: (message: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 13, lineHeight: 1.3, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      scrollback: 3000, allowProposedApi: false,
      theme: { background: '#151110', foreground: '#eae8e6', cursor: '#e07850', selectionBackground: '#e0785040',
        black: '#151110', red: '#dc6b6b', green: '#7ec699', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#eae8e6',
        brightBlack: '#a8a5a3', brightRed: '#e88888', brightGreen: '#98d1a8', brightYellow: '#ecd08f', brightBlue: '#7ec0f5', brightMagenta: '#d494e6', brightCyan: '#73c7d3', brightWhite: '#ffffff' },
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element.current!);
    const fitNow = () => {
      if (!element.current?.clientWidth || !element.current?.clientHeight) return;
      fit.fit();
      void api.resizeTerminal(info.id, Math.min(500, Math.max(2, terminal.cols)), Math.min(300, Math.max(1, terminal.rows))).catch(e => errorRef.current(e.message));
    };
    fitRef.current = fitNow;
    const observer = new ResizeObserver(fitNow); observer.observe(element.current!);
    const input = terminal.onData(data => { void api.writeTerminal(info.id, data).catch(e => errorRef.current(e.message)); });
    let disposed = false;
    let ready = false;
    let sequence = 0;
    const pending: TerminalEvent[] = [];
    const consume = (event: TerminalEvent) => {
      if (event.data && (event.sequence ?? 0) > sequence) { terminal.write(event.data); sequence = event.sequence!; }
      if (event.exitCode !== undefined) terminal.write('\\r\\n[Process exited: ' + event.exitCode + ']\\r\\n');
    };
    const off = api.onTerminal(event => {
      if (event.id !== info.id) return;
      if (ready) consume(event); else pending.push(event);
    });
    void api.terminals().then(items => {
      if (disposed) return;
      const snapshot = items.find(t => t.id === info.id) ?? info;
      terminal.write(snapshot.buffer); sequence = snapshot.sequence; ready = true;
      pending.forEach(consume); pending.length = 0;
    }).catch(e => { if (!disposed) errorRef.current(e.message); });
    fitNow();
    return () => { disposed = true; observer.disconnect(); input.dispose(); off(); terminal.dispose(); };
  }, [info.id]);
  useEffect(() => { if (visible) requestAnimationFrame(() => fitRef.current()); }, [visible]);
  return <div className="terminal-surface" style={{ display: visible ? 'block' : 'none' }} ref={element} role="region" aria-label={info.title + (api.mode === 'demo' ? ' (simulated)' : '')} />;
}
