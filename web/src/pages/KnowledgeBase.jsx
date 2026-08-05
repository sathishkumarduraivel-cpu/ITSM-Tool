import { useEffect, useState } from 'react';
import { Plus, Search, X, Loader2, BookOpen, Eye } from 'lucide-react';
import { api } from '../lib/api.js';

function NewArticleModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', category: '', body: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { article } = await api.post('/kb', form);
      onCreated(article);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New article</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Title</label>
          <input className="input" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Category</label>
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <div>
            <label className="label">Tags (comma separated)</label>
            <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">Body</label>
          <textarea className="input" rows={6} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Publish
          </button>
        </div>
      </form>
    </div>
  );
}

export default function KnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState(null);

  const load = async (query = '') => {
    setLoading(true);
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const { articles } = await api.get(`/kb?${params.toString()}`);
    setArticles(articles);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const search = (e) => {
    e.preventDefault();
    load(q);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Knowledge Base</h1>
          <p className="text-sm text-slate-500">Self-service articles &amp; runbooks</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New article</button>
      </div>

      <form onSubmit={search} className="relative max-w-md">
        <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
        <input className="input pl-8" placeholder="Search articles…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {loading && <div className="text-slate-400 text-sm py-10 text-center col-span-2">Loading…</div>}
        {!loading && articles.length === 0 && (
          <div className="col-span-2 text-center py-10 text-slate-400">
            <BookOpen className="mx-auto mb-2 text-slate-300" size={28} /> No articles yet.
          </div>
        )}
        {!loading && articles.map((a) => (
          <button key={a.id} onClick={() => setOpen(a)} className="card p-4 text-left hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-1">
              <span className="badge bg-brand-50 text-brand-700">{a.category || 'General'}</span>
              <span className="text-xs text-slate-400 flex items-center gap-1"><Eye size={12} /> {a.views}</span>
            </div>
            <h3 className="font-medium text-slate-800 mb-1">{a.title}</h3>
            <p className="text-sm text-slate-500 line-clamp-2">{a.body}</p>
          </button>
        ))}
      </div>

      {open && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4" onClick={() => setOpen(null)}>
          <div className="card w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="badge bg-brand-50 text-brand-700">{open.category || 'General'}</span>
              <button onClick={() => setOpen(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">{open.title}</h2>
            <p className="text-sm text-slate-600 whitespace-pre-line">{open.body}</p>
          </div>
        </div>
      )}

      {showNew && (
        <NewArticleModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />
      )}
    </div>
  );
}
