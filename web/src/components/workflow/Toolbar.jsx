import { useState, useRef, useEffect } from 'react';
import { GitBranch, Plus, LayoutGrid, Undo2, Redo2, ClipboardCheck } from 'lucide-react';
import { ACTION_TYPES, ACTION_ICONS } from '../../lib/workflowConstants.js';

export default function Toolbar({ onAddCondition, onAddApproval, onAddAction, onAutoArrange, onUndo, onRedo, canUndo, canRedo }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="card-flat flex items-center gap-1.5 px-2 py-1.5 shrink-0">
      <button onClick={onAddCondition} className="btn-secondary text-xs"><GitBranch size={13} /> Add condition</button>
      <button onClick={onAddApproval} className="btn-secondary text-xs"><ClipboardCheck size={13} /> Add approval</button>

      <div className="relative" ref={ref}>
        <button onClick={() => setMenuOpen((o) => !o)} className="btn-secondary text-xs"><Plus size={13} /> Add action</button>
        {menuOpen && (
          <div className="absolute z-20 top-full left-0 mt-1 w-56 card p-1.5 space-y-0.5 max-h-72 overflow-y-auto">
            {ACTION_TYPES.map((t) => {
              const Icon = ACTION_ICONS[t.value];
              return (
                <button
                  key={t.value}
                  onClick={() => { onAddAction(t.value); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
                >
                  {Icon && <Icon size={13} className="text-brand-500 shrink-0" />}
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      <button onClick={onAutoArrange} className="btn-ghost text-xs" title="Auto-arrange"><LayoutGrid size={13} /> Auto-arrange</button>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      <button onClick={onUndo} disabled={!canUndo} className="btn-ghost text-xs disabled:opacity-30" title="Undo (Ctrl+Z)"><Undo2 size={13} /></button>
      <button onClick={onRedo} disabled={!canRedo} className="btn-ghost text-xs disabled:opacity-30" title="Redo (Ctrl+Shift+Z)"><Redo2 size={13} /></button>
    </div>
  );
}
