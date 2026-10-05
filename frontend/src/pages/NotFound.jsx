import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Compass, ArrowLeft, Undo2 } from 'lucide-react';
import { usePageTitle } from '../hooks/usePageTitle.js';

// Lives inside AppShell's own inner <Routes> catch-all (App.jsx) -- unlike
// its previous silent `<Navigate to="/" replace />`, a stale bookmark, a
// mistyped URL, or a link into a since-deleted resource now says so
// explicitly instead of bouncing to Dashboard with zero explanation, while
// still keeping the sidebar/header/search all present and usable.
export default function NotFound() {
  const location = useLocation();
  const navigate = useNavigate();
  usePageTitle('Page not found');

  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-400 to-neon-500 shadow-glow-brand flex items-center justify-center mb-5">
        <Compass className="text-white" size={28} />
      </div>
      <h1 className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100 tracking-tight">Page not found</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 max-w-sm">
        There's nothing at <code className="text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5">{location.pathname}</code> — it may have moved, been removed, or the link was mistyped.
      </p>
      <div className="flex items-center gap-2 mt-6">
        <button onClick={() => navigate(-1)} className="btn-secondary"><Undo2 size={14} /> Go back</button>
        <Link to="/" className="btn-primary"><ArrowLeft size={14} /> Back to Dashboard</Link>
      </div>
    </div>
  );
}
