import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { terminalScrollback } from '../src/shared';
// CommonJS bundles: Node's ESM loader (tests) cannot see their named exports.
const Mirror = headless.Terminal; type Mirror = InstanceType<typeof Mirror>;
const { SerializeAddon } = serialize;
const { Unicode11Addon } = unicode11;

/**
 * Headless copy of a terminal's screen. Renderer panes are disposed whenever the user leaves a project, so a new
 * pane restores from this mirror instead of replaying a raw output tail: a tail loses the alternate screen, mouse
 * and paste modes enabled long ago (Pi's fullscreen TUI then scrolls xterm's own history and pastes submit early)
 * and can start inside an escape sequence.
 */
export class TerminalMirror {
  private terminal: Mirror;
  private serializer = new SerializeAddon();
  private modes = new Map<number, boolean>(); // DEC private modes the serializer does not restore
  private cursorStyle = 0; // DECSCUSR
  private parsed = 0; // sequence of the last chunk the mirror has parsed
  private waiting = new Set<(error: Error) => void>();
  private disposed = false;
  constructor(cols: number, rows: number) {
    this.terminal = new Mirror({ cols, rows, scrollback: terminalScrollback, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
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
  write(data: string, sequence: number) { if (!this.disposed) this.terminal.write(data, () => { this.parsed = sequence; }); }
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
        let data = this.serializer.serialize({ scrollback: terminalScrollback });
        for (const [mode, set] of this.modes) data += `\x1b[?${mode}${set ? 'h' : 'l'}`;
        if (this.cursorStyle) data += `\x1b[${this.cursorStyle} q`;
        resolve({ data, sequence: this.parsed });
      });
    });
  }
  dispose() { if (this.disposed) return; this.disposed = true; for (const reject of this.waiting) reject(new Error('Terminal was closed.')); this.waiting.clear(); this.terminal.dispose(); }
}
/** Modes restored on top of SerializeAddon: cursor visibility/blink and mouse encodings. */
const MirrorModes = [12, 25, 1005, 1006, 1015, 1016];
