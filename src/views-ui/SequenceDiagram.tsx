// Sequence diagram (kind: sequence) as plain SVG: sticky participant header, lifelines, activation bars, message arrows,
// fragment frames and notes. Geometry comes from sequence-layout.ts; this file only draws and handles input.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ExternalLink, FoldHorizontal, Maximize2, UnfoldHorizontal, X, ZoomIn, ZoomOut } from 'lucide-react';
import './er-diagram.css';
import './sequence-diagram.css';
import type { ErDiagramProps } from './types';
import type { SequenceMessage, SequenceParticipant } from '../views';
import { SEQ, UNCERTAIN, clip, collapseParticipants, collapsible, sequenceLayout, tabWidth, type LaidMessage, type LaidParticipant } from './sequence-layout';
import { StaleMark } from './FlowNode';

const MIN_ZOOM = 0.3, MAX_ZOOM = 2;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
const arrow = (m: SequenceMessage) => m.kind === 'return' ? '-->' : '->';
const describe = (m: SequenceMessage, name: (id: string) => string) =>
  `${name(m.from)} ${arrow(m)} ${name(m.to)}${m.label ? `: ${m.label}` : ''}${m.certain ? '' : UNCERTAIN}`;
const activate = (run: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } };

export function SequenceDiagram({ result, onOpenSource, toolbarExtra }: ErDiagramProps) {
  const full = result.sequence!;
  // Participants folded into their callers' lifelines from the inspector: this session only.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const data = useMemo(() => collapseParticipants(full, folded), [full, folded]);
  const layout = useMemo(() => sequenceLayout(data), [data]);
  const names = useMemo(() => new Map(full.participants.map(p => [p.id, p.label])), [full]);
  const name = (id: string) => names.get(id) ?? id;
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const marker = useId().replace(/:/g, '');

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms; needs a non-passive listener to keep the page from zooming.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(z => clampZoom(z * Math.exp(-e.deltaY / 300))); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('[role=button]')) return;
    const el = scroller.current!;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current, el = scroller.current;
    if (!p || !el) return;
    el.scrollLeft = p.left - (e.clientX - p.x); el.scrollTop = p.top - (e.clientY - p.y);
  };
  const fit = () => { const el = scroller.current; if (el) setZoom(clampZoom(Math.min(1, (el.clientWidth - 24) / layout.width))); };

  const open = (m: SequenceMessage) => { if (m.source) onOpenSource(m.source.file, m.source.line); };
  const W = layout.width, H = layout.height, Z = zoom;
  const participant = selected ? data.participants.find(p => p.id === selected) : undefined;
  const node = participant ? result.nodes.find(n => n.id === participant.id) : undefined;
  return <div className="er-diagram seq-diagram" data-testid="sequence-diagram" onKeyDown={e => { if (e.key === 'Escape') setSelected(null); }}>
    <div className="er-toolbar" role="toolbar" aria-label="Diagram">
      <span className="er-count">{data.participants.length} participants · {data.messages.length} messages{result.diagnostics?.sequence?.truncated || result.truncated ? ' · truncated: lower the depth or exclude files' : ''}</span>
      <button aria-label="Zoom out" title="Zoom out (Ctrl/⌘ + scroll)" onClick={() => setZoom(z => clampZoom(z / 1.2))}><ZoomOut size={13} /></button>
      <button aria-label="Reset zoom" title="Reset zoom" className="seq-zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button aria-label="Zoom in" title="Zoom in (Ctrl/⌘ + scroll)" onClick={() => setZoom(z => clampZoom(z * 1.2))}><ZoomIn size={13} /></button>
      <button aria-label="Fit width" onClick={fit}><Maximize2 size={13} />Fit</button>
      {folded.size > 0 && <button title={[...folded].map(name).join(', ')} onClick={() => setFolded(new Set())}><UnfoldHorizontal size={13} />Unfold {folded.size}</button>}
      <div className="er-toolbar-extra">{toolbarExtra}</div>
    </div>
    <div className="er-body">
      <div className="seq-canvas" ref={scroller} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }}>
        <div className="seq-sheet" style={{ width: W * Z }}>
          <div className="seq-header" style={{ height: SEQ.headerHeight * Z }}>
            <svg width={W * Z} height={SEQ.headerHeight * Z} viewBox={`0 0 ${W} ${SEQ.headerHeight}`} aria-label="Participants">
              {layout.participants.map(p => <Participant key={p.participant.id} laid={p} selected={p.participant.id === selected}
                onSelect={() => setSelected(s => s === p.participant.id ? null : p.participant.id)} />)}
            </svg>
          </div>
          {!data.messages.length && <p className="er-status seq-status">No calls found from the start symbol at this depth.</p>}
          <svg className="seq-body" width={W * Z} height={H * Z} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Messages">
            <defs>
              <marker id={`${marker}-call`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className="seq-head" /></marker>
              <marker id={`${marker}-return`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10" className="seq-head open" /></marker>
              <marker id={`${marker}-hot`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" className="seq-head hot" /></marker>
            </defs>
            {layout.messages.map(lm => <rect key={lm.message.id} className={'seq-row' + (hover === lm.row ? ' hover' : '')} x={0} y={lm.top} width={W} height={lm.bottom - lm.top}
              role="button" tabIndex={0} aria-label={`Message ${describe(lm.message, name)}${lm.message.source ? '' : ' (no source)'}`}
              onMouseEnter={() => setHover(lm.row)} onMouseLeave={() => setHover(h => h === lm.row ? null : h)} onFocus={() => setHover(lm.row)}
              onClick={() => open(lm.message)} onKeyDown={activate(() => open(lm.message))}>
              <title>{[describe(lm.message, name), lm.message.detail, lm.message.link && `link: ${lm.message.link}`,
                lm.message.source && `${lm.message.source.file}:${lm.message.source.line} — click to open`].filter(Boolean).join('\n')}</title></rect>)}
            {layout.fragments.map(f => <rect key={f.fragment.id} className={`seq-fragment ${f.fragment.kind}`} x={f.x} y={f.y} width={f.width} height={f.height} rx={4} />)}
            {layout.participants.map(p => <line key={p.participant.id} className={'seq-lifeline' + (p.participant.id === selected ? ' selected' : '')}
              x1={p.x} x2={p.x} y1={0} y2={H} />)}
            {layout.activations.map((a, i) => <rect key={i} className={'seq-bar' + (a.participant === selected ? ' selected' : '')} x={a.x} y={a.y} width={SEQ.barWidth} height={a.height} />)}
            {layout.messages.map(lm => <Message key={lm.message.id} laid={lm} hot={hover === lm.row} marker={marker} />)}
            {layout.fragments.map(f => <g key={f.fragment.id} className={`seq-fragment-head ${f.fragment.kind}`}>
              <path className="seq-fragment-tab" d={`M${f.x} ${f.y + 4} q0 -4 4 -4 H${f.x + tabWidth(f.fragment.kind)} v12 l-6 7 H${f.x} z`} />
              <text className="seq-fragment-kind" x={f.x + 7} y={f.y + 14}>{f.fragment.kind}</text>
              {f.fragment.label && f.fragment.label !== f.fragment.kind && <text className="seq-fragment-label" x={f.x + tabWidth(f.fragment.kind) + 8} y={f.y + 14}>[{clip(f.fragment.label, SEQ.maxLabel)}]<title>{f.fragment.label}</title></text>}
              {f.branches.map((b, i) => <g key={i}>
                <line className="seq-branch" x1={f.x} x2={f.x + f.width} y1={b.y} y2={b.y} />
                <text className="seq-fragment-label" x={f.x + 8} y={b.y + 16}>[{clip(b.label, SEQ.maxLabel)}]<title>{b.label}</title></text></g>)}
            </g>)}
            {layout.notes.map(n => <g key={n.note.id} className={`seq-note ${n.note.kind}`} role={n.note.source ? 'button' : undefined} tabIndex={n.note.source ? 0 : undefined}
              aria-label={`Note on ${name(n.note.participant)}: ${n.note.text}`} onClick={() => n.note.source && onOpenSource(n.note.source.file, n.note.source.line)}
              onKeyDown={activate(() => n.note.source && onOpenSource(n.note.source.file, n.note.source.line))}>
              <title>{n.note.text}{n.note.source ? `\n${n.note.source.file}:${n.note.source.line}` : ''}</title>
              <rect x={n.x} y={n.y} width={n.width} height={n.height} rx={4} />
              <text x={n.x + n.width / 2} y={n.y + n.height / 2 + 4}>{n.text}</text>
            </g>)}
          </svg>
        </div>
      </div>
      {participant && <ParticipantInspector participant={participant} explanationStatus={node?.explanationStatus} messages={data.messages} name={name}
        onClose={() => setSelected(null)} onOpenSource={onOpenSource}
        onFold={collapsible(full, participant.id) ? () => { setFolded(f => new Set([...f, participant.id])); setSelected(null); } : undefined} />}
    </div>
  </div>;
}

function Participant({ laid, selected, onSelect }: { laid: LaidParticipant; selected: boolean; onSelect(): void }) {
  const { participant: p, x, width } = laid;
  return <g className={`seq-participant ${p.kind}${selected ? ' selected' : ''}`} role="button" tabIndex={0} aria-pressed={selected}
    aria-label={`Participant ${p.label}${p.subtitle ? ` (${p.subtitle})` : ''}`} onClick={onSelect} onKeyDown={activate(onSelect)}>
    <title>{p.label}{p.subtitle ? ` — ${p.subtitle}` : ''}</title>
    {p.kind === 'actor' ? <g className="seq-actor">
      <rect x={x - width / 2} y={6} width={width} height={56} rx={6} className="seq-actor-hit" />
      <circle cx={x} cy={14} r={6} /><path d={`M${x} 20 v13 M${x - 10} 25 h20 M${x} 33 l-8 10 M${x} 33 l8 10`} />
      <text className="seq-participant-label" x={x} y={58}>{laid.label}</text>
    </g> : <>
      <rect x={x - width / 2} y={10} width={width} height={46} rx={6} />
      <text className="seq-participant-label" x={x} y={p.subtitle ? 30 : 37}>{laid.label}</text>
      {laid.subtitle && <text className="seq-participant-subtitle" x={x} y={45}>{laid.subtitle}</text>}
    </>}
  </g>;
}

function Message({ laid: lm, hot, marker }: { laid: LaidMessage; hot: boolean; marker: string }) {
  const m = lm.message, self = m.from === m.to || m.kind === 'self';
  const head = `url(#${marker}-${hot ? 'hot' : m.kind === 'return' ? 'return' : 'call'})`;
  const className = `seq-message ${m.kind}${m.certain ? '' : ' uncertain'}${hot ? ' hot' : ''}`;
  return <g className={className}>
    {self ? <path d={`M${lm.x1} ${lm.y} H${lm.x1 + SEQ.selfWidth} V${lm.y + SEQ.selfDrop} H${lm.x2}`} markerEnd={head} />
      : <line x1={lm.x1} x2={lm.x2} y1={lm.y} y2={lm.y} markerEnd={head} />}
    <text x={lm.labelX} y={self ? lm.y + SEQ.selfDrop / 2 + 4 : lm.y - 7} textAnchor={self ? 'start' : 'middle'}>
      {lm.label}{!m.certain && <tspan className="seq-uncertain">{UNCERTAIN}</tspan>}</text>
  </g>;
}

function ParticipantInspector({ participant: p, explanationStatus, messages, name, onClose, onOpenSource, onFold }: {
  participant: SequenceParticipant; explanationStatus?: Parameters<typeof StaleMark>[0]['status']; messages: SequenceMessage[];
  name(id: string): string; onClose(): void; onOpenSource: ErDiagramProps['onOpenSource']; onFold?: () => void;
}) {
  const own = messages.filter(m => m.from === p.id || m.to === p.id);
  return <aside className="er-inspector" aria-label={`Participant ${p.label}`}>
    <header><div><strong>{p.label}</strong><span>{p.kind}{p.subtitle && p.subtitle !== p.kind ? ` · ${p.subtitle}` : ''}</span></div>
      <button className="icon" aria-label="Close inspector" onClick={onClose}><X size={14} /></button></header>
    {p.source && <div className="er-inspector-source"><code title={`${p.source.file}:${p.source.line}`}>{p.source.file}:{p.source.line}</code>
      <button aria-label={`Open ${p.label} in editor`} onClick={() => onOpenSource(p.source!.file, p.source!.line)}><ExternalLink size={12} />Open in editor</button></div>}
    {onFold && <div className="er-inspector-source"><button onClick={onFold} title="Draw its calls on the caller's lifeline (this session only)">
      <FoldHorizontal size={12} />Fold into caller</button></div>}
    {p.explanation && <p className="flow-inspector-explanation"><StaleMark status={explanationStatus} />{p.explanation}</p>}
    <h4>Messages <span>{own.length}</span></h4>
    {!own.length && <p className="er-inspector-empty">No messages.</p>}
    <ul className="er-inspector-relations">
      {own.map(m => <li key={m.id}>
        <button className="er-relation" disabled={!m.source} aria-label={`Open ${describe(m, name)}`} title={m.source ? `${m.source.file}:${m.source.line}` : undefined}
          onClick={() => m.source && onOpenSource(m.source.file, m.source.line)}>
          <span>{m.from === p.id && m.to === p.id ? '↻' : m.from === p.id ? '→' : '←'}</span>
          <strong>{m.from === p.id && m.to !== p.id ? name(m.to) : m.to === p.id && m.from !== p.id ? name(m.from) : p.label}</strong>
          <small>{m.label}</small>
        </button>
        <small className="er-relation-meta">{m.kind}{m.link && m.link !== m.kind ? ` · ${m.link}` : ''}{!m.certain && ' · uncertain'}</small>
      </li>)}
    </ul>
  </aside>;
}
