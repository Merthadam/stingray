import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import type { RepoFile, RepoSnapshot, SnapshotHint } from './shared';
import { aggregate, buildRepoTree, fileKind, findFolder, inRange, kindBadges, kindLabels } from './repo-map-model';
import { treemap, type LayoutTile, type MapScope } from './repo-map-layout';
import { LineCounts } from './LineCounts';

type Props = { snapshot: RepoSnapshot | null; busy: boolean; changedOnly: boolean; onFile: (file: RepoFile) => void; viewportRef: RefObject<HTMLDivElement | null>;
  onShowAll: () => void; onHint: (hint: SnapshotHint) => void; backRef: MutableRefObject<() => void>; dismissSearchRef: MutableRefObject<() => boolean> };
export function RepoMapCanvas({ snapshot, busy, changedOnly, onFile, viewportRef, onShowAll, onHint, backRef, dismissSearchRef }: Props) {
  const [history, setHistory] = useState<MapScope[]>([{ folder: '' }]);
  const scope = history.at(-1)!;
  const [query, setQuery] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const tree = useMemo(() => buildRepoTree((snapshot?.files || []).filter(file => !changedOnly || file.status)), [snapshot, changedOnly]);
  const current = useMemo(() => findFolder(tree, scope.folder), [tree, scope.folder]);
  const nodes = useMemo(() => current.children.filter(node => (!scope.range || inRange(node, scope.range)) && (!scope.file || node.path === scope.file)), [current, scope]);
  const tiles = useMemo(() => treemap(nodes, size.width, size.height, scope.folder), [nodes, size, scope.folder]);
  const totals = useMemo(() => aggregate(nodes), [nodes]);
  const results = useMemo(() => query.trim() ? (snapshot?.files || []).filter(file => file.path.toLowerCase().includes(query.toLowerCase().trim())).slice(0, 60) : [], [query, snapshot]);
  useEffect(() => {
    const view = viewportRef.current;
    if (!view) return;
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setSize({ width: view.clientWidth, height: view.clientHeight })); });
    observer.observe(view); return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [viewportRef]);
  useEffect(() => { setActive(0); onHint({ scope: scope.folder, ...(scope.file ? { file: scope.file } : {}) }); }, [scope, onHint]);
  function back() { setHistory(previous => previous.length > 1 ? previous.slice(0, -1) : scope.folder ? [{ folder: scope.folder.split('/').slice(0, -1).join('/') }] : previous); setQuery(''); }
  backRef.current = back;
  dismissSearchRef.current = () => { if (!query) return false; setQuery(''); searchRef.current?.focus(); return true; };
  useEffect(() => { viewportRef.current?.focus({ preventScroll: true }); }, [history, viewportRef]);
  function navigate(next: MapScope) { setHistory(previous => [...previous, next]); setQuery(''); }
  function openTile(tile: LayoutTile) {
    if (tile.node?.file) onFile(tile.node.file);
    else navigate(tile.range ? { folder: tile.folder, range: tile.range } : { folder: tile.node!.path });
  }
  function revealFile(file: RepoFile) {
    if (changedOnly && !file.status) onShowAll();
    navigate({ folder: file.path.split('/').slice(0, -1).join('/'), file: file.path }); onFile(file);
  }
  function details(tile: LayoutTile) {
    const file = tile.node?.file; const measurement = file?.size;
    const sizeText = measurement ? measurement.state === 'known' ? `${measurement.textLines} text lines · ${measurement.source}${measurement.stale ? ' · awaiting revalidation' : ''}` : `${measurement.state}: ${measurement.reason} · ${measurement.source}` : 'Size pending';
    return `${file?.path || tile.node?.path || tile.name}\n${file ? kindLabels[fileKind(file.status)] + ' · ' + sizeText : `${tile.totals.total} files · ${tile.totals.textLines} known text lines · ${tile.totals.unknownSizes} unknown sizes`}\n+${tile.totals.added} / −${tile.totals.removed}${tile.totals.unknown ? ' (partial)' : ''}`;
  }
  return <div className="map-column" onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); searchRef.current?.focus(); } }}>
    <div className="map-navigation">
      <nav aria-label="Map folders"><button className="icon" aria-label="Back to parent group or folder" disabled={history.length === 1 && !scope.folder} onClick={back}><ArrowLeft size={14} /></button><button onClick={() => setHistory([{ folder: '' }])}>Root</button>{scope.folder && <button title={scope.folder} onClick={() => navigate({ folder: scope.folder })}>{scope.folder}</button>}{scope.range && <span title={scope.range.label}> / Group</span>}{scope.file && <span> / File</span>}</nav>
      <label className="map-search"><Search size={14} /><input ref={searchRef} placeholder="Find any file…" aria-label="Find a file on the map" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear file search" onClick={() => setQuery('')}><X size={12} /></button>}</label>
    </div>
    <div className="map-summary"><span>{totals.total.toLocaleString()} files · {totals.textLines.toLocaleString()} text lines{totals.unknownSizes || totals.staleSizes ? ' (partial/stale)' : ''}</span><LineCounts {...totals} /></div>
    {query.trim() && <div className="map-search-results" aria-label="File search results">
      {results.map(file => <button key={file.path} aria-label={`Find file ${file.path}`} onClick={() => revealFile(file)}><span className={`map-badge ${fileKind(file.status)}`}>{kindBadges[fileKind(file.status)]}</span><span>{file.path}{changedOnly && !file.status && <small>Hidden by Only changes · click to show all and reveal</small>}</span><LineCounts added={file.lines?.added || 0} removed={file.lines?.removed || 0} unknown={file.status && file.lines == null ? 1 : 0} notice={file.lineNotice} /></button>)}
      {!results.length && <p>No matching files.</p>}{results.length === 60 && <p>First 60 matches. Refine your search.</p>}
    </div>}
    <div className="map-viewport" ref={viewportRef} tabIndex={0} aria-label="Repository overview" onKeyDown={event => {
      if (!tiles.length) return;
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const next = (active + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + tiles.length) % tiles.length;
        setActive(next); viewportRef.current?.querySelectorAll<HTMLButtonElement>('.map-tile')[next]?.focus({ preventScroll: true });
      } else if (event.target === viewportRef.current && event.key === 'Enter') { event.preventDefault(); openTile(tiles[Math.min(active, tiles.length - 1)]); }
    }}>
      {!snapshot ? <div className="map-empty"><h3>{busy ? 'Mapping your repository…' : 'Map unavailable'}</h3><p>Reading Git inventory and bounded text sizes.</p></div> : !nodes.length ? <div className="map-empty"><h3>{changedOnly ? 'All clear.' : 'No files here'}</h3><p>{changedOnly ? 'No uncommitted changes in this view.' : 'Choose Root or search the full inventory.'}</p></div> : tiles.map((tile, index) => {
        const file = tile.node?.file; const kind = file ? fileKind(file.status) : 'clean';
        const label = file ? `${kindLabels[kind]} file ${file.path}` : tile.range ? `Explore group ${tile.name}` : `Open folder ${tile.node!.path}`;
        const visible = tile.width > 48 && tile.height > 18;
        return <button key={tile.id} tabIndex={-1} onFocus={() => setActive(index)} data-file-count={tile.totals.total} data-terminal={tile.terminal} data-parent={tile.parent} data-depth={tile.depth}
          className={`map-tile ${file ? 'file ' + kind : tile.range ? 'group' : 'folder'} ${!file && tile.totals.changed ? 'changed-folder' : ''} ${tile.terminal ? 'terminal-tile' : 'folder-frame'}`}
          style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }} aria-label={label} title={details(tile)} onClick={() => openTile(tile)}>
          {visible && <span className="tile-header"><strong>{file ? `${kindBadges[kind]} ${tile.name}` : tile.range ? `${tile.totals.total.toLocaleString()} files` : `${tile.name}/`}</strong>{tile.width > 150 && <LineCounts {...tile.totals} />}</span>}
          {tile.terminal && tile.height > 55 && tile.width > 85 && <span className="tile-detail">{file ? file.size?.state === 'known' ? `${file.size.textLines.toLocaleString()} text lines${file.size.stale ? ' · stale' : ''}` : 'Size ' + (file.size?.state || 'pending') : `${tile.totals.total.toLocaleString()} files · click to focus`}{tile.width <= 150 && <LineCounts {...tile.totals} />}</span>}
        </button>;
      })}
    </div>
    <div className="map-legend">{(['modified', 'added', 'deleted', 'conflict'] as const).map(kind => <span key={kind}><b className={`map-badge ${kind}`}>{kindLabels[kind][0] === 'C' ? '!' : kindBadges[kind]}</b>{kindLabels[kind]}</span>)}<small>Area = text lines · click folders to focus</small></div>
    <div className="map-stats-note" title={snapshot?.sizeNotice}>{snapshot?.sizeNotice || 'Sizes pending. Empty/unknown files use minimum weight, not fabricated line counts.'}</div>
    <div className="map-stats-note" title={snapshot?.statsNotice}>{snapshot?.statsNotice || '+ / − net lines vs HEAD · refreshes every 5s'}</div>
  </div>;
}
