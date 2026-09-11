import { useEffect, useState } from 'react';
import { Plus, Loader2, Link2, Trash2, CheckCircle2, XCircle, Pencil, Copy, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { PLATFORMS, platformMeta } from '../lib/externalPlatformConstants.js';
import Select from '../components/Select.jsx';

function WebhookUrlBox({ connectionId, secret }) {
  const [copied, setCopied] = useState(false);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const url = `${window.location.origin}/api/webhooks/external-sync/${connectionId}?secret=${secret}`;
  const copy = () => {
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="card-flat p-3 space-y-1.5">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Paste this URL into a webhook/automation on the external platform so its changes flow back into this app automatically. This only covers the inbound direction — pushing our edits out already works without it.
      </p>
      <div className="flex items-center gap-2">
        <code className="input text-xs flex-1 overflow-x-auto whitespace-nowrap">{url}</code>
        <button type="button" onClick={copy} className="btn-secondary text-xs shrink-0">
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {isLocal && (
        <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 rounded-md px-2 py-1.5">
          This is a <code>localhost</code> URL — the external platform's servers can't reach it. It'll only work once this app is on a real public address, or via a temporary tunnel (e.g. <code>ngrok http 4001</code>) for testing. Until then, use the manual <strong>Pull</strong> button on a linked ticket to bring in their changes.
        </p>
      )}
    </div>
  );
}

function ConnectionModal({ initial, onClose, onSaved }) {
  const [platform, setPlatform] = useState(initial?.platform || 'servicenow');
  const [name, setName] = useState(initial?.name || '');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url || '');
  const [authValues, setAuthValues] = useState({});
  const [mappingValues, setMappingValues] = useState(initial?.field_mapping || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const meta = platformMeta(platform);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Forgiving on what gets pasted here: someone copying a URL out of the
      // browser's address bar (very likely, since that's also where we tell
      // people to find a sys_id) will often grab a full page URL with a path
      // -- reduce it to just the origin so the API calls we build from it are
      // still correct, instead of silently breaking every request.
      const normalizedBaseUrl = (() => {
        try {
          const u = new URL(baseUrl.trim());
          return `${u.protocol}//${u.host}`;
        } catch {
          return baseUrl.trim().replace(/\/$/, '');
        }
      })();
      // ServiceNow table names are always lowercase technical identifiers
      // (the UI shows "Incident" capitalized, the API wants "incident") --
      // normalize rather than let the capitalization mismatch silently 404.
      const normalizedMapping = mappingValues.table !== undefined
        ? { ...mappingValues, table: mappingValues.table.trim().toLowerCase() }
        : mappingValues;
      const payload = { platform, name, base_url: normalizedBaseUrl, auth_config: authValues, field_mapping: normalizedMapping };
      if (initial?.id) await api.patch(`/external-connections/${initial.id}`, payload);
      else await api.post('/external-connections', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit connection' : 'New external connection'} onClose={onClose} maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">Platform</label>
          <Select
            value={platform} disabled={!!initial?.id}
            onChange={(v) => { setPlatform(v); setAuthValues({}); setMappingValues({}); }}
            options={PLATFORMS}
          />
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. Prod ${meta.label}`} />
        </div>
        <div>
          <label className="label">Base URL</label>
          <input className="input" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta.baseUrlPlaceholder} />
        </div>

        <div className="space-y-2">
          <label className="label mb-0">Credentials</label>
          {meta.authFields.map((f) => (
            <input
              key={f.key} type={f.type} className="input" placeholder={f.label + (initial?.id ? ' (leave blank to keep current)' : '')}
              value={authValues[f.key] ?? ''} onChange={(e) => setAuthValues({ ...authValues, [f.key]: e.target.value })}
              required={!initial?.id}
            />
          ))}
        </div>

        {meta.mappingFields.length > 0 && (
          <div className="space-y-2">
            <label className="label mb-0">Field mapping</label>
            {meta.mappingFields.map((f) => (
              <input
                key={f.key} className="input" placeholder={f.label} required={f.required}
                value={mappingValues[f.key] ?? ''} onChange={(e) => setMappingValues({ ...mappingValues, [f.key]: e.target.value })}
              />
            ))}
          </div>
        )}

        {initial?.id && <WebhookUrlBox connectionId={initial.id} secret={initial.webhook_secret} />}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Create connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ExternalConnections() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | connection
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const { connections } = await api.get('/external-connections');
      setConnections(connections);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const test = async (id) => {
    setTesting(id);
    try {
      const result = await api.post(`/external-connections/${id}/test`, {});
      setTestResult((r) => ({ ...r, [id]: result }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, error: e.message } }));
    } finally {
      setTesting('');
    }
  };

  const remove = async (id) => {
    if (!confirm('Remove this connection? Tickets linked through it will stop syncing.')) return;
    await api.del(`/external-connections/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="External Connections"
        description="Bilateral ticket sync with ServiceNow, Jira and Freshservice — edits here push out automatically, and their changes flow back in via webhook"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New connection</button>}
      />

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}
      {!loading && connections.length === 0 && (
        <EmptyState icon={Link2} description="No external connections yet — connect ServiceNow, Jira or Freshservice to start syncing tickets both ways." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {connections.map((c) => {
          const meta = platformMeta(c.platform);
          const Icon = meta.icon;
          return (
            <div key={c.id} className="card p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate">{c.name}</div>
                    <div className="text-xs text-slate-500 truncate">{meta.label} · {c.base_url}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => setModal(c)} className="text-slate-400 hover:text-brand-600"><Pencil size={15} /></button>
                  <button onClick={() => remove(c.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className={`badge ${c.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>{c.enabled ? 'Enabled' : 'Disabled'}</span>
                <button onClick={() => test(c.id)} disabled={testing === c.id} className="btn-secondary text-xs">
                  {testing === c.id ? <Loader2 size={12} className="animate-spin" /> : null} Test connection
                </button>
              </div>
              {testResult[c.id] && (
                <div className={`mt-2 text-xs rounded-md px-2 py-1.5 flex items-center gap-1.5 ${testResult[c.id].ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
                  {testResult[c.id].ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {testResult[c.id].ok ? 'Connected successfully' : testResult[c.id].error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {modal && (
        <ConnectionModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
