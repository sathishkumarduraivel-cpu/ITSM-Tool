import { useState, useRef, useEffect } from 'react';
import { ChevronsUpDown, Check, Building2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function WorkspaceSwitcher({ collapsed = false }) {
  const { user, workspaces, switchWorkspace } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (!user) return null;

  const select = async (wsId) => {
    if (wsId === user.workspace_id) { setOpen(false); return; }
    setBusy(true);
    try {
      await switchWorkspace(wsId);
      window.location.href = '/';
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title={collapsed ? user.workspace_name || 'Workspace' : undefined}
        className={`w-full flex items-center gap-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left ${collapsed ? 'justify-center px-0 py-1.5' : 'px-2 py-1.5'}`}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white font-bold text-sm shrink-0">
          <Building2 size={16} />
        </div>
        {!collapsed && (
          <>
            <div className="leading-tight min-w-0 flex-1">
              <div className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate">{user.workspace_name || 'Workspace'}</div>
              <div className="text-[11px] text-slate-400">ITSM AI</div>
            </div>
            {workspaces.length > 1 && <ChevronsUpDown size={14} className="text-slate-400 shrink-0" />}
          </>
        )}
      </button>

      {open && workspaces.length > 1 && (
        <div className={`absolute mt-1 card p-1 z-40 shadow-popover dark:shadow-popover-dark animate-pop-in ${collapsed ? 'left-0 w-56' : 'left-0 right-0'}`}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => select(w.id)}
              className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="truncate">{w.name}</span>
              {w.id === user.workspace_id && <Check size={14} className="text-brand-600 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
