// "Tables" popover: search, per-group checkboxes, all/none; clicking a name finds and centres the table.
import { useState } from 'react';
import { Search } from 'lucide-react';
import type { ViewResult } from '../views';

interface Props {
  result: ViewResult;
  hidden: Set<string>;
  onHidden(hidden: string[]): void;
  onFind(id: string): void;
}

export function TablesPopover({ result, hidden, onHidden, onFind }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = result.nodes.filter(n => !q || n.label.toLowerCase().includes(q) || n.subtitle?.toLowerCase().includes(q));
  const known = new Set(result.groups.map(g => g.id));
  const groups = [...result.groups.map(g => ({ id: g.id, label: g.label })), { id: null, label: 'Other' }]
    .map(g => ({ ...g, nodes: matches.filter(n => g.id === null ? n.group === null || !known.has(n.group) : n.group === g.id) }))
    .filter(g => g.nodes.length);
  const toggle = (id: string) => onHidden(hidden.has(id) ? [...hidden].filter(h => h !== id) : [...hidden, id]);
  return <div className="er-popover" role="dialog" aria-label="Tables">
    <label className="er-search"><Search size={13} />
      <input autoFocus placeholder="Find a table…" aria-label="Find a table" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="er-popover-actions">
      <button aria-label="Show all tables" onClick={() => onHidden([])}>All</button>
      <button aria-label="Hide all tables" onClick={() => onHidden(result.nodes.map(n => n.id))}>None</button>
    </div>
    <div className="er-popover-list">
      {groups.map(g => <section key={g.id ?? ''}>
        {groups.length > 1 && <h5>{g.label}</h5>}
        {g.nodes.map(n => <div key={n.id} className="er-popover-item">
          <input type="checkbox" checked={!hidden.has(n.id)} aria-label={`Show ${n.label}`} onChange={() => toggle(n.id)} />
          <button aria-label={`Find ${n.label}`} onClick={() => onFind(n.id)}>{n.label}{n.subtitle && <small>{n.subtitle}</small>}</button>
        </div>)}
      </section>)}
      {!groups.length && <p>No matching tables.</p>}
    </div>
  </div>;
}
