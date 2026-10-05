import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, Filter, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import CardRenderer from './CardRenderer.jsx';
import { CARD_ICONS, SPANS, titleCase } from './cardMeta.js';

// A sensible starting configuration per type, so switching type never lands
// the form in an invalid state the user has to repair before they can see
// anything.
function defaultConfig(cardType, meta) {
  const firstDim = meta.dimensions.find((d) => !d.is_time)?.key || 'status';
  switch (cardType) {
    case 'scorecard': return { metric: 'count', compare: true };
    case 'trend': return { metric: 'count', time_dim: 'month', series_dim: '', style: 'area' };
    case 'bar': return { group_by: firstDim, metrics: ['count'], orientation: 'vertical', limit: 10 };
    case 'donut': return { group_by: 'priority', metric: 'count', limit: 8 };
    case 'table': return { group_by: firstDim, metrics: ['count', 'resolved'], sort_by: 'count', sort_dir: 'desc', limit: 10 };
    case 'pivot': return { row_dim: 'team', col_dim: 'priority' };
    default: return {};
  }
}

const FILTERS = [
  { key: 'type', label: 'Ticket type', source: 'types' },
  { key: 'priority', label: 'Priority', source: 'priorities' },
  { key: 'status', label: 'Status', source: 'statuses' },
  { key: 'team', label: 'Team', source: 'teams' },
  { key: 'category', label: 'Category', source: 'categories' },
];

export default function CardEditor({ card, meta, boardRange, onClose, onSave }) {
  const editing = !!card?.id;
  const [cardType, setCardType] = useState(card?.card_type || 'scorecard');
  const [title, setTitle] = useState(card?.title || '');
  const [span, setSpan] = useState(card?.span || 6);
  const [config, setConfig] = useState(() => card?.config || defaultConfig(card?.card_type || 'scorecard', meta));
  const [filterOptions, setFilterOptions] = useState({ teams: [], categories: [], types: [], priorities: [], statuses: [] });
  const [ownRange, setOwnRange] = useState(!!card?.config?.date_range);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showFilters, setShowFilters] = useState(() => Object.keys(card?.config?.filters || {}).length > 0);

  useEffect(() => {
    api.get('/reports/filter-options', { quiet: true }).then(setFilterOptions).catch(() => {});
  }, []);

  const set = (patch) => { setConfig((c) => ({ ...c, ...patch })); setFieldErrors({}); };

  const changeType = (next) => {
    setCardType(next);
    // Carry across anything the new type also understands, so switching from
    // a bar to a table keeps your grouping and filters instead of resetting.
    const fresh = defaultConfig(next, meta);
    const carried = {};
    for (const k of ['group_by', 'metric', 'metrics', 'filters', 'date_range', 'limit']) {
      if (config[k] !== undefined && fresh[k] !== undefined) carried[k] = config[k];
    }
    if (config.filters) carried.filters = config.filters;
    if (config.date_range) carried.date_range = config.date_range;
    setConfig({ ...fresh, ...carried });
    setFieldErrors({});
  };

  const dimOptions = useMemo(() => meta.dimensions.filter((d) => !d.is_time).map((d) => ({ value: d.key, label: d.label })), [meta]);
  const allDimOptions = useMemo(() => meta.dimensions.map((d) => ({ value: d.key, label: d.label })), [meta]);
  const timeOptions = useMemo(() => meta.dimensions.filter((d) => d.is_time).map((d) => ({ value: d.key, label: d.label })), [meta]);
  const metricOptions = useMemo(() => meta.metrics.map((m) => ({ value: m.key, label: m.label })), [meta]);

  // Live preview, debounced: every keystroke in a number field would
  // otherwise be its own query.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const body = { card_type: cardType, config, date_range: ownRange ? config.date_range : boardRange };
        const { data } = await api.post('/analytics/preview', body);
        if (!cancelled) { setPreview({ data }); setPreviewError(''); }
      } catch (e) {
        if (!cancelled) { setPreview(null); setPreviewError(e.message); }
      }
    }, 320);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cardType, config, ownRange, boardRange]);

  const save = async () => {
    setSaving(true); setError(''); setFieldErrors({});
    try {
      const payload = {
        title: title.trim() || undefined,
        card_type: cardType,
        span,
        config: { ...config, date_range: ownRange ? config.date_range : undefined },
      };
      await onSave(payload);
    } catch (e) {
      const detail = e.body?.field_errors;
      if (Array.isArray(detail) && detail.length) {
        setFieldErrors(Object.fromEntries(detail.map((f) => [f.field, f.message])));
        setError('Some choices need attention.');
      } else setError(e.message);
      setSaving(false);
    }
  };

  const err = (field) => fieldErrors[field] && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{fieldErrors[field]}</p>;
  const activeFilters = Object.entries(config.filters || {}).filter(([, v]) => v);

  return (
    <Modal
      title={editing ? 'Edit card' : 'Add a card'}
      onClose={onClose}
      maxWidth="max-w-5xl"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <p className="hidden text-[11px] text-slate-400 sm:block">
            The preview uses this workspace's real data.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="button" onClick={save} disabled={saving} className="btn-primary">
              {saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save card' : 'Add card'}
            </button>
          </div>
        </div>
      )}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ---- the controls ---- */}
        <div className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div>
            <label className="label">Card type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {meta.card_types.map((t) => {
                const Icon = CARD_ICONS[t.key];
                const active = cardType === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => changeType(t.key)}
                    title={t.description}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-[11px] font-medium transition-colors ${
                      active
                        ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-white/10 dark:text-slate-300'
                    }`}
                  >
                    {Icon && <Icon size={15} />} {t.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {meta.card_types.find((t) => t.key === cardType)?.description}
            </p>
          </div>

          <div>
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={meta.card_types.find((t) => t.key === cardType)?.defaultTitle || 'Card title'}
            />
          </div>

          {/* ---- per-type options ---- */}
          {cardType === 'scorecard' && (
            <>
              <div>
                <label className="label">Metric</label>
                <Select value={config.metric} onChange={(v) => set({ metric: v })} options={metricOptions} />
                {err('metric')}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" className="rounded" checked={config.compare !== false} onChange={(e) => set({ compare: e.target.checked })} />
                Compare with the previous period
              </label>
            </>
          )}

          {cardType === 'trend' && (
            <>
              <div>
                <label className="label">Metric</label>
                <Select value={config.metric} onChange={(v) => set({ metric: v })} options={metricOptions} />
                {err('metric')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Interval</label>
                  <Select value={config.time_dim} onChange={(v) => set({ time_dim: v })} options={timeOptions} />
                </div>
                <div>
                  <label className="label">Style</label>
                  <Select
                    value={config.style} onChange={(v) => set({ style: v })}
                    options={[{ value: 'area', label: 'Area' }, { value: 'line', label: 'Line' }]}
                  />
                </div>
              </div>
              <div>
                <label className="label">Split into series <span className="font-normal text-slate-400">(optional)</span></label>
                <Select
                  value={config.series_dim || ''} onChange={(v) => set({ series_dim: v })}
                  options={[{ value: '', label: 'One line for everything' }, ...dimOptions]}
                />
                <p className="mt-1 text-[11px] text-slate-400">One line per value — e.g. a line per priority.</p>
              </div>
            </>
          )}

          {(cardType === 'bar' || cardType === 'table') && (
            <>
              <div>
                <label className="label">Group by</label>
                <Select value={config.group_by} onChange={(v) => set({ group_by: v })} options={allDimOptions} />
                {err('group_by')}
              </div>
              <div>
                <label className="label">Metrics <span className="font-normal text-slate-400">(up to 4)</span></label>
                <Select
                  multiple value={config.metrics || []} onChange={(v) => set({ metrics: v })}
                  options={metricOptions} placeholder="Choose metrics…"
                />
                {err('metrics')}
              </div>
            </>
          )}

          {cardType === 'bar' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Direction</label>
                <Select
                  value={config.orientation} onChange={(v) => set({ orientation: v })}
                  options={[{ value: 'vertical', label: 'Columns' }, { value: 'horizontal', label: 'Bars' }]}
                />
              </div>
              <div>
                <label className="label">Max bars</label>
                <input type="number" min={3} max={50} className="input" value={config.limit ?? 10} onChange={(e) => set({ limit: Number(e.target.value) })} />
              </div>
            </div>
          )}

          {cardType === 'table' && (
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className="label">Sort by</label>
                <Select
                  value={config.sort_by} onChange={(v) => set({ sort_by: v })}
                  options={(config.metrics || []).map((m) => ({ value: m, label: metricOptions.find((o) => o.value === m)?.label || m }))}
                />
              </div>
              <div>
                <label className="label">Rows</label>
                <input type="number" min={3} max={50} className="input" value={config.limit ?? 10} onChange={(e) => set({ limit: Number(e.target.value) })} />
              </div>
              <div className="col-span-3">
                <Select
                  value={config.sort_dir} onChange={(v) => set({ sort_dir: v })}
                  options={[{ value: 'desc', label: 'Highest first' }, { value: 'asc', label: 'Lowest first' }]}
                />
              </div>
            </div>
          )}

          {cardType === 'donut' && (
            <>
              <div>
                <label className="label">Break down by</label>
                <Select value={config.group_by} onChange={(v) => set({ group_by: v })} options={allDimOptions} />
                {err('group_by')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Metric</label>
                  <Select value={config.metric} onChange={(v) => set({ metric: v })} options={metricOptions} />
                </div>
                <div>
                  <label className="label">Max slices</label>
                  <input type="number" min={3} max={50} className="input" value={config.limit ?? 8} onChange={(e) => set({ limit: Number(e.target.value) })} />
                </div>
              </div>
              <p className="text-[11px] text-slate-400">Anything past the limit is gathered into “Other”, so the slices still add up to the total.</p>
            </>
          )}

          {cardType === 'pivot' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Rows</label>
                <Select value={config.row_dim} onChange={(v) => set({ row_dim: v })} options={allDimOptions} />
                {err('row_dim')}
              </div>
              <div>
                <label className="label">Columns</label>
                <Select value={config.col_dim} onChange={(v) => set({ col_dim: v })} options={allDimOptions} />
                {err('col_dim')}
              </div>
            </div>
          )}

          <div>
            <label className="label">Width on the report</label>
            <Select value={span} onChange={(v) => setSpan(Number(v))} options={SPANS.map((s) => ({ value: s.value, label: s.label }))} />
          </div>

          {/* ---- filters ---- */}
          <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <button
              type="button"
              onClick={() => setShowFilters((s) => !s)}
              className="flex w-full items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300"
            >
              <span className="flex items-center gap-1.5"><Filter size={12} /> Filters</span>
              <span className="text-slate-400">{activeFilters.length ? `${activeFilters.length} applied` : 'none'}</span>
            </button>
            {showFilters && (
              <div className="mt-3 space-y-2">
                {FILTERS.map((f) => (
                  <div key={f.key}>
                    <label className="label">{f.label}</label>
                    <Select
                      value={config.filters?.[f.key] || ''}
                      onChange={(v) => set({ filters: { ...config.filters, [f.key]: v } })}
                      options={[{ value: '', label: 'Any' }, ...(filterOptions[f.source] || []).map((o) => ({ value: o, label: titleCase(o) }))]}
                    />
                  </div>
                ))}
                {!!activeFilters.length && (
                  <button type="button" onClick={() => set({ filters: {} })} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600">
                    <X size={11} /> Clear filters
                  </button>
                )}
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox" className="mt-0.5 rounded" checked={ownRange}
              onChange={(e) => {
                setOwnRange(e.target.checked);
                set({ date_range: e.target.checked ? (config.date_range || { preset: 'last_90_days' }) : undefined });
              }}
            />
            <span>
              Use its own period
              <span className="block text-[11px] text-slate-400">Otherwise this card follows the report's period.</span>
            </span>
          </label>
          {ownRange && (
            <Select
              value={config.date_range?.preset || 'last_90_days'}
              onChange={(v) => set({ date_range: { ...(config.date_range || {}), preset: v } })}
              options={meta.date_presets.filter((p) => p.key !== 'custom').map((p) => ({ value: p.key, label: p.label }))}
            />
          )}
        </div>

        {/* ---- the live preview ---- */}
        <div className="lg:sticky lg:top-0">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Preview</span>
            {previewError && <span className="text-[11px] text-amber-600 dark:text-amber-400">Not valid yet</span>}
          </div>
          <div className="card min-h-[280px] p-4">
            <h4 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {title.trim() || meta.card_types.find((t) => t.key === cardType)?.defaultTitle}
            </h4>
            {previewError
              ? (
                <div className="flex h-[200px] flex-col items-center justify-center gap-2 px-6 text-center text-slate-400">
                  <AlertTriangle size={18} />
                  <p className="text-xs">{previewError}</p>
                </div>
              )
              : <CardRenderer card={{ card_type: cardType, span, config }} result={preview} meta={meta} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}
