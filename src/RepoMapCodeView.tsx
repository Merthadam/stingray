import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightLines } from './highlight';
// Fixed-height virtual rows: every loaded line is reachable, without rendering
// hundreds of thousands of blank-line DOM nodes. Source is always React text.
export function CodeView({ content, path, diff = false, line = null }: { content: string; path: string; diff?: boolean; line?: number | null }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const highlighted = useMemo(() => highlightLines(content, path, diff), [content, path, diff]);
  const [top, setTop] = useState(0);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!line || diff || !view.current) return;
    const top = Math.max(0, Math.min(lines.length - 1, line - 1) - 2) * 21;
    view.current.scrollTop = top; setTop(view.current.scrollTop);
  }, [line, diff]);
  const start = Math.min(Math.max(0, lines.length - 1), Math.max(0, Math.floor(top / 21) - 15));
  const end = Math.min(lines.length, start + 200);
  const longest = useMemo(() => lines.reduce((n, line) => Math.max(n, line.length), 0), [lines]);
  return <div className="code-view" ref={view} tabIndex={0} aria-label={diff ? 'Git diff content' : 'File content'} onScroll={event => setTop(event.currentTarget.scrollTop)} onKeyDown={event => {
    if (event.key === 'End' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.current?.scrollTo({ top: lines.length * 21 }); }
    if (event.key === 'Home' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.current?.scrollTo({ top: 0 }); }
  }}><pre style={{ height: lines.length * 21, minWidth: '100%', width: longest * 7 + 70, position: 'relative' }}>{lines.slice(start, end).map((text, offset) => {
    const index = start + offset;
    return <span style={{ position: 'absolute', top: index * 21, width: '100%' }} className={'code-line ' + (index + 1 === line && !diff ? 'target ' : '') + (diff ? text.startsWith('+') && !text.startsWith('+++') ? 'line-add' : text.startsWith('-') && !text.startsWith('---') ? 'line-delete' : text.startsWith('@@') ? 'line-hunk' : '' : '')} key={index}><i>{diff ? '' : index + 1}</i><code>{highlighted[index].length ? highlighted[index].map((token, i) => token.type ? <span className={'token ' + token.type} key={i}>{token.text}</span> : token.text) : ' '}</code></span>;
  })}</pre></div>;
}
