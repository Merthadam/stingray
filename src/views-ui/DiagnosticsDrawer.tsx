import { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { RuleDiagnostic, ViewResult, ViewWarning } from '../../shared/contracts/views';

type OpenSource = (file: string, line: number | null) => void;

function Location({ file, line, onOpenSource }: { file: string | null; line: number | null; onOpenSource: OpenSource }) {
  if (!file) return null;
  const text = line ? `${file}:${line}` : file;
  return <button className="views-source-link" title={`Open ${text}`} onClick={() => onOpenSource(file, line)}>{text}</button>;
}

function Warnings({ items, onOpenSource }: { items: ViewWarning[]; onOpenSource: OpenSource }) {
  return <ul className="views-diag-list">{items.map((w, i) => <li key={i}><Location file={w.file} line={w.line} onOpenSource={onOpenSource} /> {w.message}</li>)}</ul>;
}

function RuleRows({ rule, onOpenSource }: { rule: RuleDiagnostic; onOpenSource: OpenSource }) {
  const [open, setOpen] = useState(false);
  const issues = rule.errors.length + rule.warnings.length;
  return <tbody>
    <tr className={rule.errors.length ? 'has-errors' : rule.warnings.length ? 'has-warnings' : ''}>
      <td>{issues ? <button className="views-diag-expand" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{rule.rule}</button> : <span className="views-diag-rule">{rule.rule}</span>}</td>
      <td>{rule.language}</td><td>{rule.filesScanned}</td><td>{rule.matches}</td><td>{rule.emitted}</td><td>{rule.skipped}</td><td>{rule.ms}</td>
      <td>{rule.errors.length ? <span className="views-diag-error">{rule.errors.length} errors</span> : null} {rule.warnings.length ? <span className="views-diag-warning">{rule.warnings.length} warnings</span> : null}</td>
    </tr>
    {open && <tr className="views-diag-detail"><td colSpan={8}>
      {!!rule.errors.length && <Warnings items={rule.errors} onOpenSource={onOpenSource} />}
      {!!rule.warnings.length && <Warnings items={rule.warnings} onOpenSource={onOpenSource} />}
    </td></tr>}
  </tbody>;
}

/** Everything the computation reported about a view: graph status, truncation, warnings, rule feedback, links, limits. */
export function DiagnosticsDrawer({ result, onOpenSource, onClose }: { result: ViewResult; onOpenSource: OpenSource; onClose: () => void }) {
  const d = result.diagnostics;
  const stats = Object.entries(result.stats);
  return <section className="views-diagnostics" aria-label="Diagnostics">
    <header><h3>Diagnostics</h3><span className="views-muted">computed {new Date(result.computedAt).toLocaleTimeString()}{d ? ` in ${d.ms} ms` : ''}</span>
      <button className="icon" aria-label="Close diagnostics" onClick={onClose}><X size={14} /></button></header>
    <div className="views-diagnostics-body">
      <p><strong>Code graph:</strong> {result.graph.state}{result.graph.message ? ` — ${result.graph.message}` : ''}</p>
      {result.truncated && <p className="views-diag-warning" role="status">A scan limit was hit; the diagram may be incomplete.</p>}
      <h4>Warnings <span>{result.warnings.length}</span></h4>
      {result.warnings.length ? <Warnings items={result.warnings} onOpenSource={onOpenSource} /> : <p className="views-muted">None.</p>}
      {d && <>
        <h4>Rules <span>{d.rules.length}</span></h4>
        {d.rules.length ? <div className="views-diag-scroll"><table className="views-diag-rules">
          <thead><tr><th>Rule</th><th>Language</th><th>Files</th><th>Matches</th><th>Emitted</th><th>Skipped</th><th>ms</th><th>Issues</th></tr></thead>
          {d.rules.map(r => <RuleRows key={r.rule} rule={r} onOpenSource={onOpenSource} />)}
        </table></div> : <p className="views-muted">No rules.</p>}
        {d.graph && <><h4>Graph step</h4>
          <p>{d.graph.started} start symbols · {d.graph.reached} reached · {d.graph.helpers} helpers{d.graph.truncated ? ' · node cap hit' : ''}</p>
          {d.graph.error && <p className="views-diag-error">{d.graph.error}</p>}</>}
        {d.flowchart && <><h4>Flowchart</h4>
          <p>start {d.flowchart.start ?? '—'} · depth {d.flowchart.depth} · {d.flowchart.functions} functions · {d.flowchart.nodes} nodes{d.flowchart.truncated ? ' · node cap hit' : ''}</p>
          {d.flowchart.error && <p className="views-diag-error">{d.flowchart.error}</p>}</>}
        {d.layers && <><h4>Layers</h4>
          <p>{d.layers.config ?? 'inferred (no .stinggraph/layers.yaml)'} · depth {d.layers.depth} · {d.layers.services} services · {d.layers.files} files · {d.layers.nodes} nodes</p>
          {d.layers.error && <p className="views-diag-error">{d.layers.error}</p>}</>}
        {d.sequence && <><h4>Sequence</h4>
          <p>start {d.sequence.start ?? '—'} · depth {d.sequence.depth} · participants by {d.sequence.participants} · {d.sequence.functions} functions · {d.sequence.messages} messages{d.sequence.truncated ? ' · limit hit (lower the depth or exclude files)' : ''}</p>
          {Object.keys(d.sequence.links).length > 0 && <p className="views-diag-stats">{Object.entries(d.sequence.links).map(([k, v]) => <span key={k}>{k} <strong>{v}</strong></span>)}</p>}
          {d.sequence.error && <p className="views-diag-error">{d.sequence.error}</p>}</>}
        <h4>Unresolved links <span>{d.unresolved.length}</span></h4>
        {d.unresolved.length ? <ul className="views-diag-list">{d.unresolved.map((u, i) => <li key={i}>
          <Location file={u.file} line={u.line} onOpenSource={onOpenSource} /> <code>{u.value}</code> <span className="views-muted">({u.rule})</span></li>)}</ul>
          : <p className="views-muted">None.</p>}
        <h4>Limits</h4>
        <p>{d.limits.filesScanned} files scanned · {d.limits.matches} matches{d.limits.truncated ? ' · limit hit' : ''}</p>
      </>}
      {!!stats.length && <><h4>Stats</h4><p className="views-diag-stats">{stats.map(([k, v]) => <span key={k}>{k} <strong>{v}</strong></span>)}</p></>}
    </div>
  </section>;
}
