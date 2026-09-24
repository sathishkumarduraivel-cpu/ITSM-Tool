import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, Search, Loader2, BookOpen, X, Folder, FolderPlus, BarChart3, Filter,
  ThumbsUp, Eye, Clock, Trash2,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { fmtRelative } from '../lib/dates.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';
import Modal from '../components/Modal.jsx';
import ArticleEditor from '../components/kb/ArticleEditor.jsx';
import ArticleView from '../components/kb/ArticleView.jsx';
import KbInsights from '../components/kb/KbInsights.jsx';
import { Excerpt } from '../components/kb/markdown.jsx';

const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_review: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  published: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  retired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

export default function KnowledgeBase() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [tab, setTab] = useState(params.get('tab') || 'browse');
  const [open, setOpen] = useState(params.get('article') || null);
  const [editing, setEditing] = useState(undefined); // undefined closed, object = seed
  const [refresh, setRefresh] = useState(0);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    api.get('/kb/meta').then(setMeta).catch(() => setMeta(null));
    // Held at this level because both the editor and the browse sidebar need
    // them, and fetching twice would be two requests for one answer.
    api.get('/kb/categories').then((d) => setCategories(d.categories || [])).catch(() => {});
  }, [refresh]);

  const canManage = !!meta?.can_manage;

  const go = (next) => {
    setTab(next);
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Knowledge Base"
        description="What the service desk knows, written down — findable, reviewed, and measured by whether it actually helped."
        actions={canManage && (
          <button onClick={() => setEditing({})} className="btn-primary text-xs"><Plus size={13} /> New article</button>
        )}
      />

      {canManage && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
          {[['browse', 'Browse', BookOpen], ['insights', 'Insights', BarChart3]].map(([key, label, Icon]) => (
            <button key={key} onClick={() => go(key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'insights' && canManage ? (
        <KbInsights
          onWriteArticle={(seed) => setEditing(seed)}
          onOpenArticle={setOpen}
        />
      ) : (
        <Browse key={refresh} meta={meta} canManage={canManage} onOpen={setOpen} onEdit={setEditing} />
      )}

      {open && (
        <ArticleView
          articleId={open}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onEdit={(a) => { setOpen(null); setEditing(a); }}
          onChanged={(nextId) => {
            setRefresh((n) => n + 1);
            if (typeof nextId === 'string') setOpen(nextId);
          }}
        />
      )}

      {editing !== undefined && meta && (
        <ArticleEditor
          initial={editing?.id ? editing : { title: editing?.title || '' }}
          meta={meta}
          categories={categories}
          onClose={() => setEditing(undefined)}
          onSaved={(article) => { setEditing(undefined); setRefresh((n) => n + 1); setOpen(article.id); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- browse ---

function Browse({ meta, canManage, onOpen, onEdit }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [articles, setArticles] = useState(null);
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [managingCats, setManagingCats] = useState(false);
  const [error, setError] = useState('');
  const searchId = useRef(null);

  const loadList = async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (categoryId) p.set('category_id', categoryId);
      if (status) p.set('status', status);
      setArticles((await api.get(`/kb?${p}`)).articles);
    } catch (e) { setError(e.message); setArticles([]); }
  };

  const loadCategories = async () => {
    try { setCategories((await api.get('/kb/categories')).categories); } catch { /* non-fatal */ }
  };

  useEffect(() => { loadCategories(); }, []);
  useEffect(() => { loadList(); }, [categoryId, status]);

  // Debounced: search is cheap but logged, and a request per keystroke would
  // fill the gap report with every prefix somebody typed on the way.
  useEffect(() => {
    if (!q.trim()) { setResults(null); return undefined; }
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ q });
        if (categoryId) p.set('category_id', categoryId);
        const r = await api.get(`/kb/search?${p}`);
        setResults(r);
        searchId.current = r.search_id;
      } catch (e) { setError(e.message); }
    }, 350);
    return () => clearTimeout(t);
  }, [q, categoryId]);

  const openResult = (id) => {
    // Tells the server which result was actually opened, which is what
    // separates a search that worked from one that returned noise.
    if (searchId.current) api.post(`/kb/search/${searchId.current}/click`, { article_id: id }).catch(() => {});
    onOpen(id);
  };

  const showing = results ? results.results : articles;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[230px_1fr]">
      <div className="space-y-2">
        <div className="card p-2">
          <div className="mb-1 flex items-center justify-between px-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Categories</span>
            {canManage && (
              <button onClick={() => setManagingCats(true)} className="btn-ghost p-1" title="Manage categories">
                <FolderPlus size={12} />
              </button>
            )}
          </div>
          <button onClick={() => setCategoryId('')}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm ${
              !categoryId ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60'
            }`}>
            <span>All articles</span>
          </button>
          {categories.map((c) => (
            <button key={c.id} onClick={() => setCategoryId(c.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm ${
                categoryId === c.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60'
              }`}
              style={{ paddingLeft: c.parent_id ? 20 : 8 }}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Folder size={12} className="shrink-0 text-slate-400" />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">{c.article_count}</span>
            </button>
          ))}
          {categories.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-slate-400">No categories yet.</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" placeholder="Search the knowledge base…" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X size={13} />
              </button>
            )}
          </div>
          {canManage && (
            <button onClick={() => setShowFilters((s) => !s)} className="btn-secondary text-xs">
              <Filter size={12} /> {status ? `Status: ${status.replace('_', ' ')}` : 'Filter'}
            </button>
          )}
        </div>

        {showFilters && canManage && (
          <div className="card-flat flex flex-wrap gap-2 p-2">
            <Select className="w-auto min-w-[160px]" size="sm" value={status} onChange={setStatus} placeholder="Any status"
              options={[{ value: '', label: 'Any status' }, ...(meta?.statuses || []).map((s) => ({ value: s.key, label: s.label }))]} />
          </div>
        )}

        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

        {results && (
          <p className="text-xs text-slate-400">
            {results.total === 0
              ? <>Nothing matched “{results.query}”. {canManage && 'This search has been logged — it will show up under Insights as a content gap.'}</>
              : results.mode === 'any'
                // Said plainly: nothing matched every word, so these are the
                // closest thing rather than an answer. Pretending otherwise
                // wastes the reader's time.
                ? <>No article matches all of “{results.query}”. Showing the {results.total} closest {results.total === 1 ? 'match' : 'matches'}.</>
                : `${results.total} result${results.total === 1 ? '' : 's'} for “${results.query}”, best match first.`}
          </p>
        )}

        {!showing ? (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>
        ) : showing.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={results ? 'No matches' : 'No articles yet'}
            description={results
              ? 'Try fewer or different words.'
              : 'Write the first one, or start from a ticket you have already solved — that is usually the fastest way in.'}
            action={canManage && !results && <button onClick={() => onEdit({})} className="btn-primary text-xs"><Plus size={13} /> New article</button>}
          />
        ) : (
          <div className="space-y-2">
            {showing.map((a) => (
              <button key={a.id} onClick={() => (results ? openResult(a.id) : onOpen(a.id))}
                className="card w-full p-3 text-left transition-colors hover:border-brand-300 dark:hover:border-brand-500/40">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{a.title}</span>
                      {a.status !== 'published' && (
                        <span className={`badge ${STATUS_STYLE[a.status]}`}>{a.status_meta?.label || a.status}</span>
                      )}
                      {a.visibility !== 'portal' && (
                        <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                          {a.visibility_meta?.label}
                        </span>
                      )}
                      {a.is_stale && (
                        <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                          <Clock size={9} /> due a review
                        </span>
                      )}
                    </div>
                    {/* The search excerpt beats the summary when searching:
                        it shows the matched words in context. */}
                    {a.excerpt ? (
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400"><Excerpt text={a.excerpt} /></p>
                    ) : a.summary ? (
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{a.summary}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5 text-[11px] text-slate-400">
                    {a.category && <span>{a.category.name}</span>}
                    <span className="flex items-center gap-0.5"><Eye size={10} /> {a.views || 0}</span>
                    {!!a.helpful_count && <span className="flex items-center gap-0.5"><ThumbsUp size={10} /> {a.helpful_count}</span>}
                    <span>{fmtRelative(a.updated_at)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {managingCats && (
        <CategoryManager categories={categories} onClose={() => setManagingCats(false)} onChanged={() => { loadCategories(); loadList(); }} />
      )}
    </div>
  );
}

function CategoryManager({ categories, onClose, onChanged }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    try {
      await api.post('/kb/categories', { name, parent_id: parentId || null });
      setName(''); setParentId('');
      onChanged();
    } catch (e) { setError(e.message); }
  };

  const remove = async (c) => {
    if (!confirm(`Delete “${c.name}”? Articles in it stay, they just become unfiled.`)) return;
    setError('');
    try { await api.del(`/kb/categories/${c.id}`); onChanged(); } catch (e) { setError(e.message); }
  };

  return (
    <Modal title="Categories" onClose={onClose}>
      <div className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div className="space-y-1">
          {categories.length === 0 && <p className="text-xs text-slate-400">None yet.</p>}
          {categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800/60"
              style={{ paddingLeft: c.parent_id ? 24 : 8 }}>
              <span className="text-slate-700 dark:text-slate-200">{c.name}
                <span className="ml-1.5 text-[11px] text-slate-400">{c.article_count} article{c.article_count === 1 ? '' : 's'}</span>
              </span>
              <button onClick={() => remove(c)} className="text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <input className="input min-w-[140px] flex-1" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
          <Select className="w-auto min-w-[140px]" value={parentId} onChange={setParentId} placeholder="Top level"
            options={[{ value: '', label: 'Top level' }, ...categories.filter((c) => !c.parent_id).map((c) => ({ value: c.id, label: c.name }))]} />
          <button onClick={add} disabled={!name.trim()} className="btn-primary shrink-0 text-xs disabled:opacity-40">
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
    </Modal>
  );
}
