import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Ticket, Boxes, BookOpen, X } from 'lucide-react';
import { api } from '../lib/api.js';

export default function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
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
      <div className="relative">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-8 pr-7 py-1.5 text-sm"
          placeholder="Search tickets, assets, KB…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q && setOpen(true)}
        />
        {q && (
          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => { setQ(''); setResults(null); }}>
            <X size={14} />
          </button>
        )}
      </div>

      {open && q.trim() && (
        <div className="absolute left-0 right-0 sm:w-96 mt-1 card p-2 z-40 shadow-lg max-h-96 overflow-y-auto">
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
                <button key={a.id} onClick={() => go('/assets')} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
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
                <button key={k.id} onClick={() => go('/knowledge-base')} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
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
