import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Eye, Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import { Markdown } from './markdown.jsx';

// Write an article.
//
// The two things this deliberately does that a plain form would not: it shows
// what the reader will actually see (a live preview, because the body is
// markdown and writing it blind is how you get broken headings), and it is
// explicit about audience, because "who is this for" is the field with real
// consequences and the one most likely to be left on its default.
export default function ArticleEditor({ initial, meta, categories, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [tab, setTab] = useState('write');
  const [form, setForm] = useState({
    title: initial?.title || '',
    summary: initial?.summary || '',
    body: initial?.body || '',
    tags: initial?.tag_list?.join(', ') || '',
    category_id: initial?.category_id || '',
    article_type: initial?.article_type || 'how_to',
    visibility: initial?.visibility || 'portal',
    review_interval_days: initial?.review_interval_days || '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => { const { [k]: _drop, ...rest } = e; return rest; });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(''); setFieldErrors({});
    try {
      const body = { ...form, review_interval_days: form.review_interval_days === '' ? null : Number(form.review_interval_days) };
      const saved = editing
        ? await api.patch(`/kb/${initial.id}`, body)
        : await api.post('/kb', body);
      onSaved(saved.article);
    } catch (err) {
      const detail = err.body?.field_errors;
      if (Array.isArray(detail) && detail.length) {
        setFieldErrors(Object.fromEntries(detail.map((f) => [f.field, f.message])));
        setError('Some fields need attention.');
      } else setError(err.message);
    } finally { setSaving(false); }
  };

  const visibility = meta?.visibilities?.find((v) => v.key === form.visibility);
  const type = meta?.article_types?.find((t) => t.key === form.article_type);

  return (
    <Modal title={editing ? `Edit “${initial.title}”` : 'New article'} onClose={onClose} maxWidth="max-w-4xl">
      <form onSubmit={submit} className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div>
          <label className="label">Title<span className="text-red-500">*</span></label>
          <input className={`input ${fieldErrors.title ? 'border-red-400' : ''}`} required
            value={form.title} onChange={(e) => set('title', e.target.value)} />
          {fieldErrors.title && <p className="mt-1 text-xs text-red-600">{fieldErrors.title}</p>}
        </div>

        <div>
          <label className="label">Summary</label>
          <input className="input" placeholder="One line. This is what search results and the portal list show."
            value={form.summary} onChange={(e) => set('summary', e.target.value)} />
          <p className="mt-1 text-[11px] text-slate-400">Required before it can be published — a result nobody can judge is no use.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Audience<span className="text-red-500">*</span></label>
            <Select value={form.visibility} onChange={(v) => set('visibility', v)}
              options={(meta?.visibilities || []).map((v) => ({ value: v.key, label: v.label }))} />
            {visibility && <p className="mt-1 text-[11px] text-slate-400">{visibility.description}</p>}
          </div>
          <div>
            <label className="label">Type</label>
            <Select value={form.article_type} onChange={(v) => set('article_type', v)}
              options={(meta?.article_types || []).map((t) => ({ value: t.key, label: t.label }))} />
            {type && <p className="mt-1 text-[11px] text-slate-400">{type.hint}</p>}
          </div>
          <div>
            <label className="label">Category</label>
            <Select value={form.category_id} onChange={(v) => set('category_id', v)} placeholder="Unfiled"
              options={[{ value: '', label: 'Unfiled' }, ...(categories || []).map((c) => ({ value: c.id, label: c.name }))]} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Tags</label>
            <input className="input" placeholder="vpn, network" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
          </div>
          <div>
            <label className="label">Review every</label>
            <input className="input" type="number" min="1"
              placeholder={`${meta?.default_review_days || 180} days (default)`}
              value={form.review_interval_days} onChange={(e) => set('review_interval_days', e.target.value)} />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="label mb-0">Body<span className="text-red-500">*</span></label>
            <div className="flex gap-1">
              {[['write', 'Write', Pencil], ['preview', 'Preview', Eye]].map(([key, label, Icon]) => (
                <button key={key} type="button" onClick={() => setTab(key)}
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${
                    tab === key ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}>
                  <Icon size={11} /> {label}
                </button>
              ))}
            </div>
          </div>
          {tab === 'write' ? (
            <textarea
              className={`input font-mono text-xs ${fieldErrors.body ? 'border-red-400' : ''}`}
              rows={16} required value={form.body} onChange={(e) => set('body', e.target.value)}
              placeholder={'## Symptom\n\nWhat the user sees.\n\n## Resolution\n\n1. First step\n2. Second step'}
            />
          ) : (
            <div className="min-h-[300px] rounded-xl border border-slate-200 p-3 dark:border-white/10">
              {form.body ? <Markdown text={form.body} /> : <p className="text-sm text-slate-400">Nothing to preview yet.</p>}
            </div>
          )}
          {fieldErrors.body && <p className="mt-1 text-xs text-red-600">{fieldErrors.body}</p>}
          <p className="mt-1 text-[11px] text-slate-400">
            Markdown: ## headings, **bold**, `code`, - lists, [links](https://example.com).
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save changes' : 'Create draft'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
