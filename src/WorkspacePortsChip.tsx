import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUpRight, LoaderCircle, RadioTower, RefreshCw, X } from 'lucide-react';
import { api } from './api';
import type { Workspace, WorkspacePort } from './shared';
import type { useWorkspacePorts } from './useWorkspacePorts';
import { workspacePorts } from './workspace-status';
import './workspace-ports.css';

export function WorkspacePortsChip({ workspace, discovery, terminalIds, disabled, onOpen }: {
  workspace: Workspace; discovery: ReturnType<typeof useWorkspacePorts>; terminalIds: string[]; disabled: boolean;
  onOpen: (workspace: Workspace, port: WorkspacePort) => Promise<void>;
}) {
  const { terminals, containers } = discovery;
  const ports = workspacePorts(workspace,
    terminals.error ? [] : terminals.data.filter(p => !p.terminalId || terminalIds.includes(p.terminalId)),
    containers.error ? [] : containers.data);
  const loading = terminals.loading || containers.loading;
  const failed = Boolean(terminals.error || containers.error);
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [openError, setOpenError] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const id = useId();
  const cancel = () => { clearTimeout(timer.current); };
  const closeSoon = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 160); };
  const hover = () => { cancel(); timer.current = setTimeout(() => setOpen(true), 150); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    if (!ports.length) { clearTimeout(timer.current); setOpen(false); }
  }, [ports.length]);
  useEffect(() => {
    if (!open) return;
    const positionCard = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: Math.max(8, Math.min(rect.right + 8, innerWidth - 288)), top: Math.max(8, Math.min(rect.top, innerHeight - 330)) });
    };
    positionCard();
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const restore = card.current?.contains(document.activeElement);
        setOpen(false); if (restore) trigger.current?.focus();
      }
    };
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', positionCard, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', positionCard); window.removeEventListener('scroll', positionCard, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function openPort(port: WorkspacePort) {
    if (opening !== null || disabled) return;
    cancel(); setOpening(port.port); setOpenError('');
    try { await onOpen(workspace, port); if (alive.current) setOpen(false); }
    catch (e) { if (alive.current) setOpenError((e as Error).message); }
    finally { if (alive.current) setOpening(null); }
  }
  // No empty/loading/error badge: only discovered workspace ports belong on the card.
  // Discovery continues in the parent hook so new ports still appear automatically.
  if (!ports.length) return null;
  const label = `${ports.length} active ${ports.length === 1 ? 'port' : 'ports'}`;
  return <>
    <button ref={trigger} className="ports-chip ports-active"
      aria-label={`${workspace.name}: ${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={`${label} · ${workspace.name}`} aria-busy={loading} onMouseEnter={hover} onMouseLeave={closeSoon}
      onClick={() => { cancel(); setOpen(v => !v); }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); cancel(); setOpen(true); requestAnimationFrame(() => card.current?.querySelector<HTMLButtonElement>('button')?.focus()); } }}
      onBlur={event => { if (!card.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>
      <RadioTower size={11} />
      <span>{ports.length}</span>
      {failed && <AlertCircle size={10} />}
    </button>
    {open && createPortal(<div ref={card} id={id} role="dialog" aria-label={`Ports for ${workspace.name}`} className="ports-popover" style={position}
      onMouseEnter={cancel} onMouseLeave={closeSoon} onFocus={cancel}
      onBlur={event => { if (!card.current?.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) closeSoon(); }}>
      <div className="ports-popover-heading"><strong>Ports <span>{ports.length}</span></strong><div>
        <button className="icon" aria-label={`Refresh ports for ${workspace.name}`} disabled={terminals.refreshing || containers.refreshing} onClick={discovery.retry}><RefreshCw size={12} className={terminals.refreshing || containers.refreshing ? 'spin' : ''} /></button>
        <button className="icon" aria-label="Close port details" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={13} /></button>
      </div></div>
      {api.mode === 'demo' && <p className="ports-notice">Simulated demo ports — no server was started.</p>}
      <div className="port-rows">{ports.map(port => <button className="port-row" key={port.port} disabled={disabled || opening !== null} title={`Try HTTP at ${port.url}`} onClick={() => void openPort(port)}>
        {opening === port.port ? <LoaderCircle size={12} className="spin" /> : <span className="activity-dot" />}
        <span className="port-label">{opening === port.port ? 'Opening…' : port.label}<small>{port.source === 'docker' ? 'Docker' : 'Terminal'}</small></span>
        <code>:{port.port}</code><ArrowUpRight size={13} />
      </button>)}</div>
      {openError && <p className="ports-notice ports-warning" role="alert">{openError}</p>}
      {terminals.error && <p className="ports-notice ports-warning" role="status">Terminal discovery: {terminals.error}</p>}
      {containers.error && <p className="ports-notice ports-warning" role="status">Docker discovery: {containers.error}</p>}
      {failed && <button className="ports-retry" disabled={terminals.refreshing || containers.refreshing} onClick={discovery.retry}>Retry discovery</button>}
      <p className="ports-footnote">Local TCP listeners, not health checks. Opens as HTTP; use the address bar for HTTPS. No services are started or stopped.</p>
    </div>, document.body)}
  </>;
}
