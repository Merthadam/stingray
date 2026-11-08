export function LineCounts({ added, removed, unknown = 0, total = 1, notice = '', nativeTooltip = true }: { added: number; removed: number; unknown?: number; total?: number; notice?: string; nativeTooltip?: boolean }) {
  const explanation = notice || (unknown ? `${unknown} file(s) have no available line counts. Totals include known files only.` : 'Net line changes compared with HEAD, including new untracked files.');
  if (unknown > 0 && unknown === total) return <span className="line-counts unavailable" title={nativeTooltip ? explanation : undefined} aria-label="Line counts unavailable">? lines</span>;
  return <span className="line-counts" title={nativeTooltip ? explanation : undefined} aria-label={`${added} lines added, ${removed} lines removed${unknown ? ', partial total' : ''}`}>
    <span className="lines-added">+{added.toLocaleString()}</span><span className="lines-removed">-{removed.toLocaleString()}</span>{unknown > 0 && <sup>*</sup>}
  </span>;
}
