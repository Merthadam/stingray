import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-head"><h2 id="dialog-title">{title}</h2><button disabled={busy} className="icon" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}
