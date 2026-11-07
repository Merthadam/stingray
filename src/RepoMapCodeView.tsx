import { useMemo, useRef, useState } from 'react';
// Fixed-height virtual rows: every loaded line is reachable, without rendering
// hundreds of thousands of blank-line DOM nodes. Source is always React text.
export function CodeView({ content, diff = false }: { content: string; diff?: boolean }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const [top, setTop] = useState(0);
  const view = useRef<HTMLDivElement>(null);
  const start = Math.min(Math.max(0, lines.length - 1), Math.max(0, Math.floor(top / 21) - 15));
  const end = Math.min(lines.length, start + 200);
  const longest = useMemo(() => lines.reduce((n, line) => Math.max(n, line.length), 0), [lines]);
  return <div className="code-view" ref={view} tabIndex={0} aria-label={diff ? 'Git diff content' : 'File content'} onScroll={event => setTop(event.currentTarget.scrollTop)} onKeyDown={event => {
    if (event.key === 'End' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.current?.scrollTo({ top: lines.length * 21 }); }
    if (event.key === 'Home' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.current?.scrollTo({ top: 0 }); }
  }}><pre style={{ height: lines.length * 21, minWidth: '100%', width: longest * 7 + 70, position: 'relative' }}>{lines.slice(start, end).map((line, offset) => {
    const index = start + offset;
    return <span style={{ position: 'absolute', top: index * 21, width: '100%' }} className={'code-line ' + (diff ? line.startsWith('+') && !line.startsWith('+++') ? 'line-add' : line.startsWith('-') && !line.startsWith('---') ? 'line-delete' : line.startsWith('@@') ? 'line-hunk' : '' : '')} key={index}><i>{diff ? '' : index + 1}</i><code>{line || ' '}</code></span>;
  })}</pre></div>;
}
