export function DemoBadge({ mode }: { mode: 'desktop' | 'demo' }) {
  return mode === 'demo' ? <span className="demo-badge" role="status" aria-label="Demo data">DEMO</span> : null;
}
