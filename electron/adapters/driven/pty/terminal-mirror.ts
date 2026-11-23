import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { terminalScrollback } from '../../../../shared/contracts/terminals';
import type { TerminalMirrorPort } from '../../../core/terminals';
import { serializeTerminal } from './terminal-serialize';
// CommonJS bundles: Node's ESM loader (tests) cannot see their named exports.
const Mirror = headless.Terminal; type Mirror = InstanceType<typeof Mirror>;
const { Unicode11Addon } = unicode11;

/**
 * Headless copy of a terminal's screen. Renderer panes are disposed whenever the user leaves a project, so a new
 * pane restores from this mirror instead of replaying a raw output tail: a tail loses the alternate screen, mouse
 * and paste modes enabled long ago (Pi's fullscreen TUI then scrolls xterm's own history and pastes submit early)
 * and can start inside an escape sequence.
 */
export class TerminalMirror implements TerminalMirrorPort {
  private terminal: Mirror;
  private modes = new Map<number, boolean>(); // DEC private modes the serializer does not restore
  private cursorStyle = 0; // DECSCUSR
  private parsed = 0; // sequence of the last chunk the mirror has parsed
  private waiting = new Set<(error: Error) => void>();
  private disposed = false;
  private failed = false;
  constructor(cols: number, rows: number) {
    this.terminal = new Mirror({ cols, rows, scrollback: terminalScrollback, allowProposedApi: true });
    this.terminal.loadAddon(new Unicode11Addon()); this.terminal.unicode.activeVersion = '11';
    // Observe only: returning false lets xterm apply the sequence as usual.
    const track = (set: boolean) => (params: (number | number[])[]) => {
      for (const p of params) if (typeof p === 'number' && MirrorModes.includes(p)) this.modes.set(p, set);
      return false;
    };
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
    this.terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => { this.cursorStyle = typeof params[0] === 'number' ? params[0] : 0; return false; });
    // RIS resets every mode.
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => { this.modes.clear(); this.cursorStyle = 0; return false; });
  }
  write(data: string, sequence: number, done?: () => void) {
    if (this.disposed) { done?.(); return; }
    try { this.terminal.write(data, () => { this.parsed = sequence; done?.(); }); } catch (error) {
      // A parser error must not stop the stream; the chunk still reaches the renderer (logged once per terminal).
      if (!this.failed) { this.failed = true; console.error('Terminal mirror write failed:', error); }
      done?.();
    }
  }
  resize(cols: number, rows: number) { if (!this.disposed) this.terminal.resize(cols, rows); }
  /** Screen, scrollback and modes after every chunk written so far has been parsed. */
  snapshot(): Promise<{ data: string; sequence: number }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('Terminal was closed.')); return; }
      this.waiting.add(reject);
      // Callbacks run in write order, so this one sees exactly the chunks up to `parsed`.
      this.terminal.write('', () => {
        if (this.disposed) return; // already rejected by dispose()
        this.waiting.delete(reject);
        let { data } = serializeTerminal(this.terminal, terminalScrollback);
        data += serializeModes(this.terminal);
        for (const [mode, set] of this.modes) data += `\x1b[?${mode}${set ? 'h' : 'l'}`;
        if (this.cursorStyle) data += `\x1b[${this.cursorStyle} q`;
        resolve({ data, sequence: this.parsed });
      });
    });
  }
  dispose() { if (this.disposed) return; this.disposed = true; for (const reject of this.waiting) reject(new Error('Terminal was closed.')); this.waiting.clear(); this.terminal.dispose(); }
}
/** Input modes xterm exposes publicly (from @xterm/addon-serialize's _serializeModes). */
function serializeModes(terminal: Mirror) {
  const m = terminal.modes;
  let s = '';
  if (m.applicationCursorKeysMode) s += '\x1b[?1h';
  if (m.applicationKeypadMode) s += '\x1b[?66h';
  if (m.bracketedPasteMode) s += '\x1b[?2004h';
  if (m.insertMode) s += '\x1b[4h';
  if (m.originMode) s += '\x1b[?6h';
  if (m.reverseWraparoundMode) s += '\x1b[?45h';
  if (m.sendFocusMode) s += '\x1b[?1004h';
  if (m.wraparoundMode === false) s += '\x1b[?7l';
  s += ({ none: '', x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h' } as const)[m.mouseTrackingMode];
  return s;
}
/** Modes restored on top of serializeModes: cursor visibility/blink and mouse encodings. */
const MirrorModes = [12, 25, 1005, 1006, 1015, 1016];
