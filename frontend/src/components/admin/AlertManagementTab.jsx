import { useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, Siren, Radio, ListFilter, Activity, Copy, Check,
  ToggleLeft, ToggleRight, RefreshCw, BellRing, CheckCircle2, XCircle, EyeOff, Clock,
  KeyRound, FlaskConical, AlertTriangle, Ticket as TicketIcon, ChevronDown, ChevronUp,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

const SUB_TABS = [
  { key: 'console', label: 'Alert Console', icon: Activity },
  { key: 'sources', label: 'Sources', icon: Radio },
  { key: 'rules', label: 'Rules', icon: ListFilter },
  { key: 'monitors', label: 'Internal Monitors', icon: BellRing },
];

const SEVERITY_META = {
  critical: { label: 'Critical', cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300', dot: 'bg-red-500' },
  high: { label: 'High', cls: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300', dot: 'bg-orange-500' },
  medium: { label: 'Medium', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300', dot: 'bg-amber-500' },
  low: { label: 'Low', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300', dot: 'bg-sky-500' },
  info: { label: 'Info', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', dot: 'bg-slate-400' },
};

const STATUS_META = {
  open: { label: 'Open', cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' },
  acknowledged: { label: 'Acknowledged', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
  resolved: { label: 'Resolved', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
  suppressed: { label: 'Suppressed', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

const SOURCE_TYPE_LABELS = {
  generic: 'Generic JSON webhook', datadog: 'Datadog', prometheus: 'Prometheus Alertmanager',
  grafana: 'Grafana', nagios: 'Nagios', zabbix: 'Zabbix', internal: 'ITSM internal monitors',
};

// SQLite stamps these without a zone marker; treat them as the UTC they are.
function fmtSqlite(value) {
  if (!value) return '—';
  const s = String(value);
  const iso = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function SecretReveal({ secret, path }) {
  const [copied, setCopied] = useState(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}${path}`;

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <span>This secret is shown once and never again. Paste it into your monitoring tool now — you can rotate it later, but you cannot read it back.</span>
      </div>
      <div>
        <label className="label">Webhook URL</label>
        <div className="flex gap-2">
          <input readOnly className="input font-mono text-xs" value={url} onFocus={(e) => e.target.select()} />
          <button onClick={() => copy(url, 'url')} className="btn-secondary shrink-0" aria-label="Copy URL">
            {copied === 'url' ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      <div>
        <label className="label">Secret — send as the <code className="font-mono">x-webhook-secret</code> header</label>
        <div className="flex gap-2">
          <input readOnly className="input font-mono text-xs" value={secret} onFocus={(e) => e.target.select()} />
          <button onClick={() => copy(secret, 'secret')} className="btn-secondary shrink-0" aria-label="Copy secret">
            {copied === 'secret' ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      <details className="rounded-xl border border-slate-200 p-3 text-xs dark:border-white/10">
        <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">Test it from a terminal</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[11px] leading-relaxed text-slate-100">{`curl -X POST ${url} \\
  -H 'Content-Type: application/json' \\
  -H 'x-webhook-secret: ${secret}' \\
  -d '{"title":"Disk full","entity":"db-01","severity":"critical"}'`}</pre>
      </details>
    </div>
  );
}

function SourceModal({ initial, meta, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [sourceType, setSourceType] = useState(initial?.source_type || 'generic');
  const [severity, setSeverity] = useState(initial?.default_severity || 'medium');
  const [dedupe, setDedupe] = useState(initial?.dedupe_window_minutes ?? 60);
  const [cap, setCap] = useState(initial?.max_per_minute ?? 60);
  const [fieldMap, setFieldMap] = useState(initial?.field_map || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const preset = meta?.presets?.[sourceType];

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name, source_type: sourceType, default_severity: severity,
        dedupe_window_minutes: Number(dedupe), max_per_minute: Number(cap),
        field_map: fieldMap.trim() || null,
      };
      if (initial) {
        await api.patch(`/alerts/sources/${initial.id}`, body);
        onSaved();
      } else {
        const resp = await api.post('/alerts/sources', body);
        // Hold the modal open to show the one-time secret.
        setCreated(resp);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <Modal title={`${created.source.name} is ready`} onClose={() => { onSaved(); }} maxWidth="max-w-xl">
        <div className="space-y-4">
          <SecretReveal secret={created.webhook_secret} path={created.webhook_path} />
          <div className="flex justify-end">
            <button onClick={() => onSaved()} className="btn-primary">Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={initial ? 'Edit alert source' : 'New alert source'} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Datadog" required />
          </div>
          <div>
            <label className="label">Monitoring tool</label>
            <Select
              value={sourceType}
              onChange={setSourceType}
              disabled={!!initial}
              options={(meta?.source_types || ['generic']).filter((t) => t !== 'internal').map((t) => ({ value: t, label: SOURCE_TYPE_LABELS[t] || t }))}
            />
          </div>
        </div>

        {preset && (
          <div className="rounded-xl border border-slate-200 p-2.5 text-xs dark:border-white/10">
            <p className="font-medium text-slate-700 dark:text-slate-200">How this tool&apos;s payload is read</p>
            <ul className="mt-1 grid gap-x-4 gap-y-0.5 text-slate-500 sm:grid-cols-2 dark:text-slate-400">
              {Object.entries(preset).map(([k, v]) => (
                <li key={k}><span className="text-slate-400">{k}</span> ← <code className="font-mono">{v || '—'}</code></li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Default severity</label>
            <Select value={severity} onChange={setSeverity} options={(meta?.severities || ['medium']).map((s) => ({ value: s, label: SEVERITY_META[s]?.label || s }))} />
          </div>
          <div>
            <label className="label">Dedupe window (min)</label>
            <input type="number" min="0" max="1440" className="input" value={dedupe} onChange={(e) => setDedupe(e.target.value)} />
          </div>
          <div>
            <label className="label">Max per minute</label>
            <input type="number" min="0" max="10000" className="input" value={cap} onChange={(e) => setCap(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Inside the dedupe window a repeat of the same alert raises its occurrence count instead of opening another — that is what stops a flapping check
          creating hundreds of incidents. Set the window to 0 to treat every notification as distinct, or the cap to 0 for no rate limit.
        </p>

        <div>
          <label className="label">Custom field map (optional JSON)</label>
          <textarea
            className="input min-h-[70px] font-mono text-xs"
            value={fieldMap}
            onChange={(e) => setFieldMap(e.target.value)}
            placeholder={'{"title":"alert.name","entity":"labels.host"}'}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Overrides individual paths from the preset above. Dotted paths reach into nested JSON.
          </p>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save' : 'Create source'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SourcesPane({ meta, onChanged }) {
  const [sources, setSources] = useState(null);
  const [modal, setModal] = useState(null);
  const [rotated, setRotated] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    api.get('/alerts/sources').then((d) => setSources(d.sources)).catch((e) => { setError(e.message); setSources([]); });
  };
  useEffect(load, []);

  const toggle = async (s) => { await api.patch(`/alerts/sources/${s.id}`, { enabled: !s.enabled }); load(); };
  const remove = async (s) => {
    if (!window.confirm(`Delete "${s.name}"? Its alerts stay, but the webhook stops working immediately.`)) return;
    await api.del(`/alerts/sources/${s.id}`);
    load();
  };
  const rotate = async (s) => {
    if (!window.confirm(`Rotate the secret for "${s.name}"? The old one stops working at once.`)) return;
    setRotated(await api.post(`/alerts/sources/${s.id}/rotate-secret`, {}));
  };
  const test = async (s) => {
    setTesting(s.id);
    setTestResult(null);
    try {
      setTestResult({ id: s.id, ...(await api.post(`/alerts/sources/${s.id}/test`, {})) });
      onChanged?.();
    } catch (e) {
      setTestResult({ id: s.id, error: e.message });
    } finally {
      setTesting(null);
    }
  };

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!sources) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading sources…</p>;

  const external = sources.filter((s) => s.source_type !== 'internal');
  const internal = sources.filter((s) => s.source_type === 'internal');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          One source per monitoring tool. Each gets its own webhook URL and secret, plus its own dedupe window and rate cap.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary shrink-0"><Plus size={14} /> New source</button>
      </div>

      {external.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No alert sources yet"
          description="Add one to give a monitoring tool a webhook it can post alerts to. Datadog, Grafana, Prometheus, Nagios and Zabbix payloads are understood out of the box."
          action={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New source</button>}
        />
      ) : (
        <div className="space-y-2">
          {external.map((s) => (
            <div key={s.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{s.name}</h4>
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{SOURCE_TYPE_LABELS[s.source_type] || s.source_type}</span>
                    {!s.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                    {s.open_alerts > 0 && (
                      <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">{s.open_alerts} open</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    <span>Dedupe {s.dedupe_window_minutes}m</span>
                    <span>Cap {s.max_per_minute === 0 ? 'none' : `${s.max_per_minute}/min`}</span>
                    <span>Default {s.default_severity}</span>
                    <span>Last received {fmtSqlite(s.last_received_at)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <button onClick={() => test(s)} disabled={testing === s.id} className="btn-secondary text-xs">
                    {testing === s.id ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Send test
                  </button>
                  <button onClick={() => rotate(s)} className="btn-ghost p-1.5" aria-label="Rotate secret"><KeyRound size={14} /></button>
                  <button onClick={() => toggle(s)} className="btn-ghost p-1.5" aria-label={s.enabled ? 'Disable' : 'Enable'}>
                    {s.enabled ? <ToggleRight size={18} className="text-emerald-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
                  </button>
                  <button onClick={() => setModal(s)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>
                  <button onClick={() => remove(s)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              </div>

              {testResult?.id === s.id && (
                <div className={`mt-2 rounded-xl px-3 py-2 text-xs ${
                  testResult.error
                    ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                    : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                }`}>
                  {testResult.error
                    ? testResult.error
                    : <>
                      Test alert {testResult.result?.action}
                      {testResult.rules?.ticket ? ` — created incident ${testResult.rules.ticket.number}` : ''}
                      {testResult.rules?.assigned ? `, assigned to ${testResult.rules.assigned.name}` : ''}
                      {testResult.rules?.applied === false ? ` (no rule matched: ${testResult.rules.reason})` : ''}
                    </>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {internal.length > 0 && (
        <div className="card p-4">
          <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{internal[0].name}</h4>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Created automatically for the internal monitors below. It has no webhook and cannot be posted to from outside.
          </p>
        </div>
      )}

      {modal && (
        <SourceModal
          initial={modal === 'new' ? null : modal}
          meta={meta}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); onChanged?.(); }}
        />
      )}
      {rotated && (
        <Modal title="New webhook secret" onClose={() => setRotated(null)} maxWidth="max-w-xl">
          <div className="space-y-4">
            <SecretReveal secret={rotated.webhook_secret} path={rotated.webhook_path} />
            <div className="flex justify-end"><button onClick={() => setRotated(null)} className="btn-primary">Done</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RuleModal({ initial, meta, sources, schedules, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: initial?.name || '',
    rule_order: initial?.rule_order ?? 1,
    match_severity: initial?.match_severity || '',
    match_source_id: initial?.match_source_id || '',
    match_title_contains: initial?.match_title_contains || '',
    match_entity_contains: initial?.match_entity_contains || '',
    action_create_incident: initial ? !!initial.action_create_incident : true,
    action_incident_priority: initial?.action_incident_priority || '',
    action_suppress: !!initial?.action_suppress,
    action_notify_schedule_id: initial?.action_notify_schedule_id || '',
    action_promote_major: !!initial?.action_promote_major,
    stop_processing: initial ? !!initial.stop_processing : true,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF((cur) => ({ ...cur, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial) await api.patch(`/alerts/rules/${initial.id}`, f);
      else await api.post('/alerts/rules', f);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit alert rule' : 'New alert rule'} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_100px]">
          <div>
            <label className="label">Rule name</label>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Critical alerts become incidents" required />
          </div>
          <div>
            <label className="label">Order</label>
            <input type="number" min="1" className="input" value={f.rule_order} onChange={(e) => set('rule_order', Number(e.target.value))} />
          </div>
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">When an alert matches</h5>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Severity</label>
              <Select
                value={f.match_severity} onChange={(v) => set('match_severity', v)}
                options={[{ value: '', label: 'Any severity' }, ...(meta?.severities || []).map((s) => ({ value: s, label: SEVERITY_META[s]?.label || s }))]}
              />
            </div>
            <div>
              <label className="label">Source</label>
              <Select
                value={f.match_source_id} onChange={(v) => set('match_source_id', v)}
                options={[{ value: '', label: 'Any source' }, ...sources.map((s) => ({ value: s.id, label: s.name }))]}
              />
            </div>
            <div>
              <label className="label">Title contains</label>
              <input className="input" value={f.match_title_contains} onChange={(e) => set('match_title_contains', e.target.value)} placeholder="Any" />
            </div>
            <div>
              <label className="label">Entity contains</label>
              <input className="input" value={f.match_entity_contains} onChange={(e) => set('match_entity_contains', e.target.value)} placeholder="e.g. prod-" />
            </div>
          </div>
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Then</h5>
          <div className="space-y-2">
            <button type="button" onClick={() => set('action_suppress', !f.action_suppress)} className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left dark:border-white/10">
              {f.action_suppress ? <ToggleRight size={18} className="mt-0.5 shrink-0 text-red-600" /> : <ToggleLeft size={18} className="mt-0.5 shrink-0 text-slate-400" />}
              <span>
                <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">Suppress it</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">Known noise. Nothing else in this rule runs.</span>
              </span>
            </button>

            {!f.action_suppress && (
              <>
                <button type="button" onClick={() => set('action_create_incident', !f.action_create_incident)} className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left dark:border-white/10">
                  {f.action_create_incident ? <ToggleRight size={18} className="mt-0.5 shrink-0 text-brand-600" /> : <ToggleLeft size={18} className="mt-0.5 shrink-0 text-slate-400" />}
                  <span>
                    <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">Raise an incident</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">A real ticket with SLA and numbering, routed by your assignment policies.</span>
                  </span>
                </button>

                {f.action_create_incident && (
                  <div className="ml-6 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label">Incident priority</label>
                      <Select
                        value={f.action_incident_priority} onChange={(v) => set('action_incident_priority', v)}
                        options={[
                          { value: '', label: 'From the alert severity' },
                          { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                          { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
                        ]}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="label">Page an on-call schedule</label>
                  <Select
                    value={f.action_notify_schedule_id} onChange={(v) => set('action_notify_schedule_id', v)}
                    options={[{ value: '', label: 'Do not page anyone' }, ...schedules.map((s) => ({ value: s.id, label: s.name }))]}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Whoever holds the rotation is notified at once, and the schedule&apos;s escalation steps chase it if nobody acknowledges.
                  </p>
                </div>

                <button type="button" onClick={() => set('action_promote_major', !f.action_promote_major)} className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left dark:border-white/10">
                  {f.action_promote_major ? <ToggleRight size={18} className="mt-0.5 shrink-0 text-red-600" /> : <ToggleLeft size={18} className="mt-0.5 shrink-0 text-slate-400" />}
                  <span>
                    <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">Declare a major incident</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">Opens an MI record and forces the ticket to critical. Reserve this for rules that only match genuine outages.</span>
                  </span>
                </button>
              </>
            )}

            <button type="button" onClick={() => set('stop_processing', !f.stop_processing)} className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left dark:border-white/10">
              {f.stop_processing ? <ToggleRight size={18} className="mt-0.5 shrink-0 text-brand-600" /> : <ToggleLeft size={18} className="mt-0.5 shrink-0 text-slate-400" />}
              <span>
                <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">Stop after this rule</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">Leave on so a specific rule near the top claims an alert before a broad catch-all below sees it.</span>
              </span>
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save rule' : 'Create rule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RulesPane({ meta }) {
  const [rules, setRules] = useState(null);
  const [sources, setSources] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [r, s, sch] = await Promise.all([
        api.get('/alerts/rules'),
        api.get('/alerts/sources').catch(() => ({ sources: [] })),
        api.get('/oncall/schedules').catch(() => ({ schedules: [] })),
      ]);
      setRules(r.rules);
      setSources((s.sources || []).filter((x) => x.source_type !== 'internal'));
      setSchedules(sch.schedules || []);
    } catch (e) {
      setError(e.message);
      setRules([]);
    }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (r) => { await api.patch(`/alerts/rules/${r.id}`, { enabled: !r.enabled }); load(); };
  const remove = async (r) => {
    if (!window.confirm(`Delete rule "${r.name}"?`)) return;
    await api.del(`/alerts/rules/${r.id}`);
    load();
  };

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!rules) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading rules…</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Rules run in order. The first one that matches decides what happens to the alert — raise an incident, page on-call, or suppress it as known noise.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary shrink-0"><Plus size={14} /> New rule</button>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={ListFilter}
          title="No alert rules yet"
          description="Alerts will be recorded but nothing will happen to them. Add a rule to turn the ones that matter into incidents and page whoever is on call."
          action={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New rule</button>}
        />
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">#{r.rule_order}</span>
                    <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{r.name}</h4>
                    {!r.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {r.match_severity ? `${SEVERITY_META[r.match_severity]?.label} alerts` : 'Any alert'}
                    {r.match_title_contains ? ` with "${r.match_title_contains}" in the title` : ''}
                    {r.match_entity_contains ? ` on entities matching "${r.match_entity_contains}"` : ''}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {r.action_suppress ? <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><EyeOff size={10} /> suppress</span> : null}
                    {r.action_create_incident && !r.action_suppress ? <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><TicketIcon size={10} /> raise incident</span> : null}
                    {r.action_notify_schedule_id ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><BellRing size={10} /> page on-call</span> : null}
                    {r.action_promote_major ? <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle size={10} /> major incident</span> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => toggle(r)} className="btn-ghost p-1.5" aria-label={r.enabled ? 'Disable' : 'Enable'}>
                    {r.enabled ? <ToggleRight size={18} className="text-emerald-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
                  </button>
                  <button onClick={() => setModal(r)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>
                  <button onClick={() => remove(r)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <RuleModal
          initial={modal === 'new' ? null : modal}
          meta={meta} sources={sources} schedules={schedules}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function MonitorModal({ initial, meta, onClose, onSaved }) {
  const types = meta?.monitor_types || [];
  const [monitorType, setMonitorType] = useState(initial?.monitor_type || types[0]?.key || 'sla_at_risk');
  const selected = types.find((t) => t.key === monitorType);
  const [name, setName] = useState(initial?.name || '');
  const [threshold, setThreshold] = useState(initial?.threshold ?? selected?.defaultThreshold ?? 1);
  const [windowMinutes, setWindowMinutes] = useState(initial?.window_minutes ?? 60);
  const [severity, setSeverity] = useState(initial?.severity || 'high');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const changeType = (key) => {
    setMonitorType(key);
    const t = types.find((x) => x.key === key);
    if (t && !initial) {
      setThreshold(t.defaultThreshold ?? 1);
      if (!name) setName(t.label);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { name, monitor_type: monitorType, threshold: Number(threshold), window_minutes: Number(windowMinutes), severity };
      if (initial) await api.patch(`/alerts/monitors/${initial.id}`, body);
      else await api.post('/alerts/monitors', body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit monitor' : 'New internal monitor'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Watches your own service desk data and raises an alert when something is going wrong — no external tool involved.
        </p>
        <div>
          <label className="label">What to watch</label>
          <Select value={monitorType} onChange={changeType} disabled={!!initial} options={types.map((t) => ({ value: t.key, label: t.label }))} />
          {selected && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{selected.description}</p>}
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={selected?.label || 'Monitor'} required />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">{selected?.thresholdLabel || 'Threshold'}</label>
            <input type="number" min="0" className="input" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </div>
          <div>
            <label className="label">Window (min)</label>
            <input type="number" min="1" max="10080" className="input" value={windowMinutes} onChange={(e) => setWindowMinutes(e.target.value)} />
          </div>
          <div>
            <label className="label">Severity</label>
            <Select value={severity} onChange={setSeverity} options={(meta?.severities || []).map((s) => ({ value: s, label: SEVERITY_META[s]?.label || s }))} />
          </div>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save' : 'Create monitor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MonitorsPane({ meta, onChanged }) {
  const [monitors, setMonitors] = useState(null);
  const [modal, setModal] = useState(null);
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    api.get('/alerts/monitors').then((d) => setMonitors(d.monitors)).catch((e) => { setError(e.message); setMonitors([]); });
  };
  useEffect(load, []);

  const toggle = async (m) => { await api.patch(`/alerts/monitors/${m.id}`, { enabled: !m.enabled }); load(); };
  const remove = async (m) => {
    if (!window.confirm(`Delete monitor "${m.name}"?`)) return;
    await api.del(`/alerts/monitors/${m.id}`);
    load();
  };
  const run = async (m) => {
    setRunning(m.id);
    setResult(null);
    try {
      const r = await api.post(`/alerts/monitors/${m.id}/run`, {});
      setResult({ id: m.id, ...r.result });
      load();
      onChanged?.();
    } catch (e) {
      setResult({ id: m.id, error: e.message });
    } finally {
      setRunning(null);
    }
  };

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!monitors) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading monitors…</p>;

  const typeFor = (key) => (meta?.monitor_types || []).find((t) => t.key === key);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Internal monitors are evaluated every minute in the background — the one thing here that cannot wait for someone to open a page.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary shrink-0"><Plus size={14} /> New monitor</button>
      </div>

      {monitors.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="No internal monitors yet"
          description="Add one to be told when an SLA is about to breach, a critical ticket is sitting unassigned, or the queue is growing faster than it drains."
          action={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New monitor</button>}
        />
      ) : (
        <div className="space-y-2">
          {monitors.map((m) => (
            <div key={m.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{m.name}</h4>
                    <span className={`badge ${SEVERITY_META[m.severity]?.cls || ''}`}>{SEVERITY_META[m.severity]?.label || m.severity}</span>
                    {!m.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{typeFor(m.monitor_type)?.description || m.monitor_type}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    <span>{typeFor(m.monitor_type)?.thresholdLabel || 'Threshold'}: {m.threshold}</span>
                    <span>Window {m.window_minutes}m</span>
                    <span><Clock size={10} className="mr-0.5 inline" /> Checked {fmtSqlite(m.last_evaluated_at)}</span>
                    {m.last_triggered_at && <span className="text-amber-600 dark:text-amber-400">Last fired {fmtSqlite(m.last_triggered_at)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => run(m)} disabled={running === m.id} className="btn-secondary text-xs">
                    {running === m.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Run now
                  </button>
                  <button onClick={() => toggle(m)} className="btn-ghost p-1.5" aria-label={m.enabled ? 'Disable' : 'Enable'}>
                    {m.enabled ? <ToggleRight size={18} className="text-emerald-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
                  </button>
                  <button onClick={() => setModal(m)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>
                  <button onClick={() => remove(m)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
              {result?.id === m.id && (
                <div className={`mt-2 rounded-xl px-3 py-2 text-xs ${
                  result.error ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                    : result.triggered ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'
                      : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                }`}>
                  {result.error ? result.error
                    : result.triggered
                      ? `Condition met — ${result.payload?.title} (alert ${result.action})`
                      : 'Checked just now: nothing wrong.'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <MonitorModal
          initial={modal === 'new' ? null : modal}
          meta={meta}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function ConsolePane({ reloadKey }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('open');
  const [expanded, setExpanded] = useState(null);
  const [events, setEvents] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const load = () => {
    setError('');
    api.get(`/alerts${status ? `?status=${status}` : ''}`)
      .then(setData)
      .catch((e) => { setError(e.message); setData({ alerts: [], counts: {} }); });
  };
  useEffect(load, [status, reloadKey]);

  const act = async (alert, action) => {
    setBusy(alert.id);
    try {
      await api.post(`/alerts/${alert.id}/${action}`, {});
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const expand = async (alert) => {
    if (expanded === alert.id) { setExpanded(null); return; }
    setExpanded(alert.id);
    if (!events[alert.id]) {
      try {
        const d = await api.get(`/alerts/${alert.id}/events`);
        setEvents((cur) => ({ ...cur, [alert.id]: d.events }));
      } catch { /* the trail is supplementary; a failure here shouldn't break the row */ }
    }
  };

  if (error && !data) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading alerts…</p>;

  const counts = data.counts || {};

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {[
            { key: 'open', label: `Open${counts.open ? ` (${counts.open})` : ''}` },
            { key: 'acknowledged', label: `Acknowledged${counts.acknowledged ? ` (${counts.acknowledged})` : ''}` },
            { key: 'resolved', label: 'Resolved' },
            { key: 'suppressed', label: 'Suppressed' },
            { key: '', label: 'All' },
          ].map((f) => (
            <button
              key={f.key} onClick={() => setStatus(f.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                status === f.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button onClick={load} className="btn-secondary text-xs"><RefreshCw size={12} /> Refresh</button>
      </div>

      {data.alerts.length === 0 ? (
        <EmptyState
          icon={Siren}
          title={status === 'open' ? 'No open alerts' : 'Nothing here'}
          description={status === 'open' ? 'Quiet right now. Alerts from your monitoring tools and internal monitors will appear here.' : 'No alerts with this status.'}
        />
      ) : (
        <div className="space-y-2">
          {data.alerts.map((a) => {
            const sev = SEVERITY_META[a.severity] || SEVERITY_META.info;
            const st = STATUS_META[a.status] || STATUS_META.open;
            return (
              <div key={a.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
                      <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{a.title}</h4>
                      <span className={`badge ${sev.cls}`}>{sev.label}</span>
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                      {a.occurrence_count > 1 && (
                        <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">×{a.occurrence_count}</span>
                      )}
                      {a.ticket_number && (
                        <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><TicketIcon size={10} /> {a.ticket_number}</span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {a.entity && <span className="font-mono">{a.entity}</span>}
                      {a.source_name && <span>via {a.source_name}</span>}
                      <span>First seen {fmtSqlite(a.first_seen_at)}</span>
                      {a.occurrence_count > 1 && <span>Last seen {fmtSqlite(a.last_seen_at)}</span>}
                      {a.acknowledged_by_name && <span>Acked by {a.acknowledged_by_name}</span>}
                    </div>
                    {a.description && (
                      <p className="mt-1.5 whitespace-pre-line text-xs text-slate-600 dark:text-slate-300">{a.description.slice(0, 400)}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {a.status === 'open' && (
                      <button onClick={() => act(a, 'acknowledge')} disabled={busy === a.id} className="btn-secondary text-xs">
                        {busy === a.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Acknowledge
                      </button>
                    )}
                    {a.status !== 'resolved' && (
                      <button onClick={() => act(a, 'resolve')} disabled={busy === a.id} className="btn-secondary text-xs"><XCircle size={12} /> Resolve</button>
                    )}
                    {a.status === 'open' && (
                      <button onClick={() => act(a, 'suppress')} disabled={busy === a.id} className="btn-ghost p-1.5" aria-label="Suppress"><EyeOff size={14} /></button>
                    )}
                    <button onClick={() => expand(a)} className="btn-ghost p-1.5" aria-label="History">
                      {expanded === a.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                </div>

                {expanded === a.id && (
                  <div className="mt-2 border-t border-slate-100 pt-2 dark:border-white/5">
                    {!events[a.id] ? (
                      <p className="text-xs text-slate-400">Loading history…</p>
                    ) : (
                      <ul className="space-y-1">
                        {events[a.id].map((ev) => (
                          <li key={ev.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                            <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{ev.event}</span>
                            <span className="text-slate-600 dark:text-slate-300">{ev.detail}</span>
                            <span className="ml-auto text-slate-400">{fmtSqlite(ev.created_at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AlertManagementTab() {
  const [tab, setTab] = useState('console');
  const [meta, setMeta] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/alerts/meta').then(setMeta).catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="py-10 text-center text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }
  if (!meta) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading alert configuration…</p>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          <Siren size={18} className="text-red-500" /> Alert Management
        </h3>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Take in alerts from your monitoring tools and from your own service desk data, collapse the repeats, and turn the ones that matter into incidents with an owner.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key} onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'console' && <ConsolePane reloadKey={reloadKey} />}
      {tab === 'sources' && <SourcesPane meta={meta} onChanged={() => setReloadKey((k) => k + 1)} />}
      {tab === 'rules' && <RulesPane meta={meta} />}
      {tab === 'monitors' && <MonitorsPane meta={meta} onChanged={() => setReloadKey((k) => k + 1)} />}
    </div>
  );
}
