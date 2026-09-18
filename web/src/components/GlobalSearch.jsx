import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Ticket, Boxes, BookOpen, X } from 'lucide-react';
import { api } from '../lib/api.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export default function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    function onKeyDown(e) {
      const isShortcut = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isShortcut) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        inputRef.current?.blur();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(null); return; }
    const handle = setTimeout(async () => {
      try {
        const data = await api.get(`/search?q=${encodeURIComponent(query)}`);
        setResults(data);
        setOpen(true);
      } catch {
        setResults(null);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [q]);

  const go = (path) => {
    navigate(path);
    setOpen(false);
    setQ('');
  };

  const hasResults = results && (results.tickets.length || results.assets.length || results.kb.length);

  return (
    <div className="relative" ref={ref}>
      <div className="relative command-glow rounded-full">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          className={`input rounded-full pl-11 pr-16 py-2 text-sm bg-slate-100/80 dark:bg-slate-800/60 border-transparent shadow-inner focus:bg-white dark:focus:bg-slate-900 transition-colors ${q ? 'text-left' : 'text-center focus:text-left'}`}
          placeholder="Search tickets, assets, KB…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q && setOpen(true)}
        />
        {q ? (
          <button className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => { setQ(''); setResults(null); }}>
            <X size={14} />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-0.5 text-[10px] font-medium text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-full px-2 py-0.5 pointer-events-none">
            {isMac ? '⌘' : 'Ctrl'}K
          </kbd>
        )}
      </div>

      {open && q.trim() && (
        <div className="absolute left-0 right-0 sm:w-96 mt-1.5 card p-2 z-40 shadow-popover dark:shadow-popover-dark animate-pop-in max-h-96 overflow-y-auto">
          {!hasResults && <div className="text-sm text-slate-400 px-2 py-3 text-center">No matches for "{q}"</div>}

          {results?.tickets.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1">Tickets</div>
              {results.tickets.map((t) => (
                <button key={t.id} onClick={() => go(`/tickets/${t.id}`)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
                  <Ticket size={14} className="text-brand-500 shrink-0" />
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{t.number} — {t.title}</span>
                </button>
              ))}
            </div>
          )}

          {results?.assets.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1">Assets</div>
              {results.assets.map((a) => (
                <button key={a.id} onClick={() => go(`/assets?selected=${a.id}`)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
                  <Boxes size={14} className="text-amber-500 shrink-0" />
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{a.tag} — {a.name}</span>
                </button>
              ))}
            </div>
          )}

          {results?.kb.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1">Knowledge Base</div>
              {results.kb.map((k) => (
                <button key={k.id} onClick={() => go(`/knowledge-base?selected=${k.id}`)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
                  <BookOpen size={14} className="text-emerald-500 shrink-0" />
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{k.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
