import { useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, Tags, ToggleLeft, ToggleRight, X, Check, ChevronRight,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';

// `embedded` drops the page-level heading and closing note, for when this is
// rendered inside Field Manager's Category row rather than as its own
// admin section.
export default function TicketCategoriesTab({ embedded = false }) {
  const [categories, setCategories] = useState(null);
  const [error, setError] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null);      // category id
  const [editName, setEditName] = useState('');
  const [newSub, setNewSub] = useState({});          // categoryId -> draft name
  const [editingSub, setEditingSub] = useState(null);
  const [editSubName, setEditSubName] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => {
    setError('');
    api.get('/ticket-categories?all=1')
      .then((d) => setCategories(d.categories))
      .catch((e) => { setError(e.message); setCategories([]); });
  };
  useEffect(load, []);

  const apply = (resp) => {
    if (resp?.categories) setCategories(resp.categories);
    else load();
  };

  const addCategory = async (e) => {
    e.preventDefault();
    if (!newCategory.trim()) return;
    setAdding(true);
    setError('');
    try {
      apply(await api.post('/ticket-categories', { name: newCategory.trim() }));
      setNewCategory('');
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const saveCategory = async (category) => {
    if (!editName.trim()) return;
    setError('');
    try {
      apply(await api.patch(`/ticket-categories/${category.id}`, { name: editName.trim() }));
      setEditing(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleCategory = async (category) => {
    setError('');
    try {
      apply(await api.patch(`/ticket-categories/${category.id}`, { active: !category.active }));
    } catch (err) {
      setError(err.message);
    }
  };

  const removeCategory = async (category) => {
    if (!window.confirm(`Delete "${category.name}"? If any tickets still use it, it will be deactivated instead so their history stays intact.`)) return;
    setError('');
    setNotice('');
    try {
      const resp = await api.del(`/ticket-categories/${category.id}`);
      apply(resp);
      if (resp.deactivated) {
        setNotice(`"${category.name}" is used by ${resp.tickets} ticket(s), so it was deactivated rather than deleted — it no longer appears in the picker but existing tickets keep their value.`);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const addSub = async (category) => {
    const name = String(newSub[category.id] || '').trim();
    if (!name) return;
    setError('');
    try {
      apply(await api.post(`/ticket-categories/${category.id}/subcategories`, { name }));
      setNewSub((cur) => ({ ...cur, [category.id]: '' }));
    } catch (err) {
      setError(err.message);
    }
  };

  const saveSub = async (sub) => {
    if (!editSubName.trim()) return;
    setError('');
    try {
      apply(await api.patch(`/ticket-categories/subcategories/${sub.id}`, { name: editSubName.trim() }));
      setEditingSub(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleSub = async (sub) => {
    setError('');
    try {
      apply(await api.patch(`/ticket-categories/subcategories/${sub.id}`, { active: !sub.active }));
    } catch (err) {
      setError(err.message);
    }
  };

  const removeSub = async (sub) => {
    setError('');
    try {
      apply(await api.del(`/ticket-categories/subcategories/${sub.id}`));
    } catch (err) {
      setError(err.message);
    }
  };

  if (!categories) {
    return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading categories…</p>;
  }

  return (
    <div className="space-y-4">
      {!embedded && (
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            <Tags size={18} className="text-brand-600" /> Ticket Categories
          </h3>
          <p className="mt-0.5 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            The category and subcategory lists agents pick from. These were free-text boxes before, which meant every typo became its own category in reporting —
            and the AI classifier had a separate hardcoded list of its own. This is now the single source of truth for both.
          </p>
        </div>
      )}

      {notice && (
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          {notice}
          <button onClick={() => setNotice('')} className="btn-ghost ml-2 p-0.5" aria-label="Dismiss"><X size={12} /></button>
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <form onSubmit={addCategory} className="flex gap-2">
        <input
          className="input" value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
          placeholder="Add a category — e.g. Telephony"
        />
        <button type="submit" disabled={adding || !newCategory.trim()} className="btn-primary shrink-0">
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </form>

      {categories.length === 0 ? (
        <EmptyState icon={Tags} title="No categories yet" description="Add your first category above, then give it subcategories." />
      ) : (
        <div className="space-y-2">
          {categories.map((category) => {
            const open = openId === category.id;
            const activeSubs = category.subcategories.filter((s) => s.active).length;
            return (
              <div key={category.id} className={`card p-0 overflow-hidden ${!category.active ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <button
                    onClick={() => setOpenId(open ? null : category.id)}
                    className="btn-ghost p-1"
                    aria-label={open ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight size={15} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                  </button>

                  {editing === category.id ? (
                    <>
                      <input
                        className="input w-auto min-w-[200px] flex-1" value={editName} autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCategory(category); } }}
                      />
                      <button onClick={() => saveCategory(category)} className="btn-primary text-xs"><Check size={12} /> Save</button>
                      <button onClick={() => setEditing(null)} className="btn-secondary text-xs">Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setOpenId(open ? null : category.id)} className="flex-1 text-left">
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{category.name}</span>
                        <span className="ml-2 text-xs text-slate-400">
                          {activeSubs} subcategor{activeSubs === 1 ? 'y' : 'ies'}
                        </span>
                        {!category.active && <span className="badge ml-2 bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">hidden</span>}
                      </button>
                      <button onClick={() => { setEditing(category.id); setEditName(category.name); }} className="btn-ghost p-1.5" aria-label="Rename"><Pencil size={13} /></button>
                      <button onClick={() => toggleCategory(category)} className="btn-ghost p-1.5" aria-label={category.active ? 'Hide' : 'Show'}>
                        {category.active ? <ToggleRight size={17} className="text-emerald-600" /> : <ToggleLeft size={17} className="text-slate-400" />}
                      </button>
                      <button onClick={() => removeCategory(category)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={13} /></button>
                    </>
                  )}
                </div>

                {open && (
                  <div className="border-t border-slate-100 bg-slate-50/60 p-3 dark:border-white/5 dark:bg-slate-800/30">
                    {category.subcategories.length === 0 ? (
                      <p className="mb-2 text-xs text-slate-400">No subcategories yet — agents will see no subcategory picker for this category.</p>
                    ) : (
                      <ul className="mb-2 space-y-1">
                        {category.subcategories.map((sub) => (
                          <li key={sub.id} className={`flex flex-wrap items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 dark:bg-slate-900/60 ${!sub.active ? 'opacity-60' : ''}`}>
                            {editingSub === sub.id ? (
                              <>
                                <input
                                  className="input w-auto min-w-[160px] flex-1 px-2 py-1 text-xs" value={editSubName} autoFocus
                                  onChange={(e) => setEditSubName(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveSub(sub); } }}
                                />
                                <button onClick={() => saveSub(sub)} className="btn-primary text-xs"><Check size={11} /></button>
                                <button onClick={() => setEditingSub(null)} className="btn-secondary text-xs">Cancel</button>
                              </>
                            ) : (
                              <>
                                <span className="flex-1 text-xs text-slate-700 dark:text-slate-200">{sub.name}</span>
                                {!sub.active && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">hidden</span>}
                                <button onClick={() => { setEditingSub(sub.id); setEditSubName(sub.name); }} className="btn-ghost p-1" aria-label="Rename"><Pencil size={11} /></button>
                                <button onClick={() => toggleSub(sub)} className="btn-ghost p-1" aria-label={sub.active ? 'Hide' : 'Show'}>
                                  {sub.active ? <ToggleRight size={15} className="text-emerald-600" /> : <ToggleLeft size={15} className="text-slate-400" />}
                                </button>
                                <button onClick={() => removeSub(sub)} className="btn-ghost p-1 text-red-500" aria-label="Delete"><Trash2 size={11} /></button>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2">
                      <input
                        className="input px-2.5 py-1.5 text-xs"
                        value={newSub[category.id] || ''}
                        onChange={(e) => setNewSub((cur) => ({ ...cur, [category.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(category); } }}
                        placeholder={`Add a subcategory under ${category.name}`}
                      />
                      <button onClick={() => addSub(category)} disabled={!String(newSub[category.id] || '').trim()} className="btn-secondary shrink-0 text-xs">
                        <Plus size={12} /> Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Renaming a category also updates every ticket already filed under it, so reporting stays continuous. Hiding one keeps it off the picker without touching history.
        The same list is what the AI classifier is allowed to choose from.
      </p>
    </div>
  );
}
