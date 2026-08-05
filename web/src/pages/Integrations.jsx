import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Plug, Trash2, CheckCircle2, XCircle, Slack, Webhook, Bell } from 'lucide-react';
import { api } from '../lib/api.js';

const EVENTS = ['ticket_created', 'ticket_assigned', 'sla_breach', 'approval_requested', 'change_approved', 'ticket_resolved'];

function NotificationTemplatesPanel() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ event: EVENTS[0], channel: 'in_app', subject: '', body: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { templates } = await api.get('/notifications/templates');
    setTemplates(templates);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/notifications/templates', form);
      setForm({ event: EVENTS[0], channel: 'in_app', subject: '', body: '' });
      load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => { await api.del(`/notifications/templates/${id}`); load(); };
  const toggle = async (t) => { await api.patch(`/notifications/templates/${t.id}`, { enabled: !t.enabled }); load(); };

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5"><Bell size={14} /> Notification templates</h3>
      <p className="text-xs text-slate-500 mb-3">Customize the message sent for each event. Use <code>{'{{number}}'}</code>, <code>{'{{title}}'}</code> placeholders.</p>

      {!loading && templates.length > 0 && (
        <div className="space-y-2 mb-4">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-slate-700">{t.event.replace('_', ' ')} <span className="text-xs text-slate-400">({t.channel})</span></div>
                <div className="text-xs text-slate-500 truncate">{t.body}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => toggle(t)} className={`badge ${t.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{t.enabled ? 'enabled' : 'disabled'}</button>
                <button onClick={() => remove(t.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <select className="input" value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>
          {EVENTS.map((ev) => <option key={ev} value={ev}>{ev.replace('_', ' ')}</option>)}
        </select>
        <select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
          {['in_app', 'email', 'slack'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="input col-span-2" placeholder="Subject (optional)" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        <textarea className="input col-span-2" rows={2} required placeholder="Message body, e.g. Ticket {{number}} was just created" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <button type="submit" disabled={saving} className="btn-primary col-span-2 justify-center text-xs">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add template
        </button>
      </form>
    </div>
  );
}

const TYPES = [
  { value: 'slack', label: 'Slack (incoming webhook)' },
  { value: 'teams', label: 'Microsoft Teams (incoming webhook)' },
  { value: 'webhook', label: 'Generic webhook' },
  { value: 'email_smtp', label: 'Email (SMTP — simulated in this build)' },
  { value: 'jira', label: 'Jira (simulated in this build)' },
];

function NewIntegrationModal({ onClose, onCreated }) {
  const [type, setType] = useState('slack');
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const config = ['slack', 'teams', 'webhook', 'jira'].includes(type) ? { webhook_url: webhookUrl } : { to_default: webhookUrl };
      await api.post('/integrations', { type, name, config });
      onCreated();
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
          <h2 className="font-semibold text-slate-800">Connect integration</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Type</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #it-alerts" />
        </div>
        <div>
          <label className="label">{['slack', 'teams', 'webhook', 'jira'].includes(type) ? 'Webhook URL' : 'Default recipient'}</label>
          <input className="input" required value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Connect
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Integrations() {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState({});

  const load = async () => {
    setLoading(true);
    const { integrations } = await api.get('/integrations');
    setIntegrations(integrations);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const test = async (id) => {
    setTesting(id);
    try {
      const result = await api.post(`/integrations/${id}/test`, {});
      setTestResult((r) => ({ ...r, [id]: result }));
    } catch (e) {
      setTestResult((r) => ({ ...r, [id]: { ok: false, error: e.message } }));
    } finally {
      setTesting('');
    }
  };

  const remove = async (id) => {
    if (!confirm('Remove this integration?')) return;
    await api.del(`/integrations/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Integrations</h1>
          <p className="text-sm text-slate-500">Connect Slack, Teams, webhooks, email &amp; ticketing tools</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> Connect integration</button>
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}
      {!loading && integrations.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <Plug className="mx-auto mb-2 text-slate-300" size={28} /> No integrations connected yet.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {integrations.map((i) => (
          <div key={i.id} className="card p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                  {i.type === 'slack' ? <Slack size={16} /> : <Webhook size={16} />}
                </div>
                <div>
                  <div className="font-medium text-slate-800">{i.name}</div>
                  <div className="text-xs text-slate-500 capitalize">{i.type.replace('_', ' ')}</div>
                </div>
              </div>
              <button onClick={() => remove(i.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className={`badge ${i.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{i.enabled ? 'Enabled' : 'Disabled'}</span>
              <button onClick={() => test(i.id)} disabled={testing === i.id} className="btn-secondary text-xs">
                {testing === i.id ? <Loader2 size={12} className="animate-spin" /> : null} Send test
              </button>
            </div>
            {testResult[i.id] && (
              <div className={`mt-2 text-xs rounded-md px-2 py-1.5 flex items-center gap-1.5 ${testResult[i.id].ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                {testResult[i.id].ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {testResult[i.id].ok ? (testResult[i.id].simulated ? 'Simulated send OK' : 'Delivered successfully') : testResult[i.id].error}
              </div>
            )}
          </div>
        ))}
      </div>

      <NotificationTemplatesPanel />

      {showNew && (
        <NewIntegrationModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />
      )}
    </div>
  );
}
