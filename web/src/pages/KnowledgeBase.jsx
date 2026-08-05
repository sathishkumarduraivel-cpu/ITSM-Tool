import { useEffect, useState } from 'react';
import { Plus, Search, X, Loader2, BookOpen, Eye, Pencil } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

function ArticleModal({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: initial?.title || '', category: initial?.category || '', body: initial?.body || '', tags: initial?.tags || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/kb/${initial.id}`, form);
      else await api.post('/kb', form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit article' : 'New article'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
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
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Publish'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function KnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // null | 'new' | article
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
      <PageHeader
        title="Knowledge Base"
        description="Self-service articles & runbooks"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New article</button>}
      />

      <form onSubmit={search} className="relative max-w-md">
        <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
        <input className="input pl-8" placeholder="Search articles…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>

      {loading && <SkeletonRows count={4} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {!loading && articles.length === 0 && (
          <div className="col-span-2"><EmptyState icon={BookOpen} description="No articles yet." /></div>
        )}
        {!loading && articles.map((a) => (
          <div key={a.id} className="card p-4 text-left hover:shadow-md dark:hover:shadow-none dark:hover:border-slate-700 transition-shadow relative group">
            <button onClick={() => setOpen(a)} className="w-full text-left">
              <div className="flex items-center justify-between mb-1 pr-6">
                <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400">{a.category || 'General'}</span>
                <span className="text-xs text-slate-400 flex items-center gap-1"><Eye size={12} /> {a.views}</span>
              </div>
              <h3 className="font-medium text-slate-800 dark:text-slate-100 mb-1">{a.title}</h3>
              <p className="text-sm text-slate-500 line-clamp-2">{a.body}</p>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setModal(a); }}
              className="absolute top-4 right-4 text-slate-400 hover:text-brand-600"
            >
              <Pencil size={14} />
            </button>
          </div>
        ))}
      </div>

      {open && (
        <div className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 flex items-center justify-center z-50 px-4" onClick={() => setOpen(null)}>
          <div className="card w-full max-w-2xl p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400">{open.category || 'General'}</span>
              <button onClick={() => setOpen(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-3">{open.title}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-line">{open.body}</p>
          </div>
        </div>
      )}

      {modal && (
        <ArticleModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
