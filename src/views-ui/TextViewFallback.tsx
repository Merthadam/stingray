import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Copy, Search } from 'lucide-react';
import type { ViewResult } from '../views';
import { formatText } from '../views-text';
import { matchingLines, splitMatches } from '../views-tab-model';

/** Kinds without a drawn diagram yet: the CLI's text form, read-only and searchable. */
export function TextViewFallback({ result, toolbar }: { result: ViewResult; toolbar: ReactNode }) {
  const lines = useMemo(() => formatText(result).split('\n'), [result]);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const hits = useMemo(() => matchingLines(lines, query), [lines, query]);
  const at = hits.length ? Math.min(current, hits.length - 1) : -1;
  useEffect(() => { if (at >= 0) body.current?.children[hits[at]]?.scrollIntoView({ block: 'nearest' }); }, [at, hits]);
  const step = (by: number) => { if (hits.length) setCurrent((at + by + hits.length) % hits.length); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Clipboard denied: the text stays selectable. */ }
  };
  return <div className="views-text">
    <div className="views-toolbar">
      <strong>{result.name}</strong><span className="views-muted">{result.kind} · {result.nodes.length} nodes · {result.edges.length} edges</span>
      <span className="views-toolbar-spacer" />{toolbar}
    </div>
    <p className="views-text-note">This view type isn't drawn in the app yet — here is its text form.</p>
    <div className="views-text-tools">
      <label className="views-search"><Search size={13} /><input aria-label="Search the text" placeholder="Search…" value={query}
        onChange={e => { setQuery(e.target.value); setCurrent(0); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} /></label>
      {query && <span className="views-muted" role="status">{hits.length ? `${at + 1} of ${hits.length}` : 'No matches'}</span>}
      <button className="icon" aria-label="Previous match" disabled={!hits.length} onClick={() => step(-1)}><ChevronUp size={14} /></button>
      <button className="icon" aria-label="Next match" disabled={!hits.length} onClick={() => step(1)}><ChevronDown size={14} /></button>
      <span className="views-toolbar-spacer" />
      <button className="views-tool" onClick={() => void copy()}><Copy size={13} /> {copied ? 'Copied' : 'Copy'}</button>
    </div>
    <pre className="views-text-body" ref={body} aria-label="Text diagram">{lines.map((line, i) =>
      <span key={i} className={'views-text-line' + (i === hits[at] ? ' current' : '')}>{splitMatches(line, query).map((p, j) => p.match ? <mark key={j}>{p.text}</mark> : p.text)}</span>)}</pre>
  </div>;
}
