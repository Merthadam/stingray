// Right-hand panel for the selected table: all fields, relations (both directions) and source links.
import { ExternalLink, X } from 'lucide-react';
import type { DiagramEdge, DiagramNode, SourceRef } from '../views';

interface Props {
  node: DiagramNode;
  variant?: 'tables' | 'flow';
  nodes: Map<string, DiagramNode>;
  edges: DiagramEdge[];
  onSelect(id: string): void;
  onClose(): void;
  onOpenSource(file: string, line: number | null): void;
}

function OpenButton({ source, label, onOpenSource }: { source: SourceRef; label: string; onOpenSource: Props['onOpenSource'] }) {
  return <button className="er-open" aria-label={`Open ${label} in editor`} title={`${source.file}:${source.line}`}
    onClick={() => onOpenSource(source.file, source.line)}><ExternalLink size={12} /></button>;
}

const fieldLabel = (node: DiagramNode | undefined, id: string | null) => id === null ? null : node?.fields.find(f => f.id === id)?.label ?? id;

export function Inspector({ node, nodes, edges, onSelect, onClose, onOpenSource, variant = 'tables' }: Props) {
  const relations = edges.filter(e => e.from === node.id || e.to === node.id);
  return <aside className="er-inspector" aria-label={`${variant === 'tables' ? 'Table' : 'Step'} ${node.label}`}>
    <header>
      <div><strong>{node.label}</strong>{node.subtitle && <span>{node.subtitle}</span>}</div>
      <button className="icon" aria-label="Close inspector" onClick={onClose}><X size={14} /></button>
    </header>
    {node.source && <div className="er-inspector-source">
      <code>{node.source.file}:{node.source.line}</code>
      <button aria-label={`Open ${node.label} in editor`} onClick={() => onOpenSource(node.source!.file, node.source!.line)}><ExternalLink size={12} />Open in editor</button>
    </div>}
    {variant === 'flow' && node.detail && <p className="flow-inspector-detail">{node.detail}</p>}
    {variant === 'tables' && <><h4>Columns <span>{node.fields.length}</span></h4>
    <ul className="er-inspector-fields">
      {node.fields.map(f => <li key={f.id}>
        <div><span className="er-row-name">{f.label}</span>
          <span className="er-badges">{f.badges.map(b => <b key={b} className={`er-badge ${b.toLowerCase()}`}>{b}</b>)}</span>
          <span className="er-row-type">{f.type ?? '?'}</span>
          {f.source && <OpenButton source={f.source} label={`${node.label}.${f.label}`} onOpenSource={onOpenSource} />}</div>
        {f.detail && <small>{f.detail}</small>}
      </li>)}
    </ul></>}
    <h4>{variant === 'tables' ? 'Relations' : 'Transitions'} <span>{relations.length}</span></h4>
    {!relations.length && <p className="er-inspector-empty">No relations.</p>}
    <ul className="er-inspector-relations">
      {relations.map(e => {
        const outgoing = e.from === node.id;
        const other = nodes.get(outgoing ? e.to : e.from);
        const own = fieldLabel(node, outgoing ? e.fromField : e.toField);
        const theirs = fieldLabel(other, outgoing ? e.toField : e.fromField);
        return <li key={e.id}>
          <button className="er-relation" aria-label={`Select ${other?.label ?? 'table'}`} onClick={() => other && onSelect(other.id)}>
            <span>{outgoing ? '→' : '←'}</span>
            <strong>{other?.label ?? (outgoing ? e.to : e.from)}{theirs && `.${theirs}`}</strong>
            {own && <small>via {own}</small>}
          </button>
          <small className="er-relation-meta">{e.kind}{e.label && ` · ${e.label}`}{!e.certain && ' · uncertain'}</small>
        </li>;
      })}
    </ul>
  </aside>;
}
