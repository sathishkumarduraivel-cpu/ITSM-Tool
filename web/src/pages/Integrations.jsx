import { useEffect, useState } from 'react';
import { Plus, Loader2, Plug, Trash2, CheckCircle2, XCircle, Slack, Webhook, Bell, Mail, Pencil, Globe2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission } from '../lib/permissions.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';

const EVENTS = ['ticket_created', 'ticket_assigned', 'sla_breach', 'approval_requested', 'change_approved', 'change_rejected', 'ticket_resolved'];

function NotificationTemplatesPanel() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ event: EVENTS[0], channel: 'in_app', subject: '', body: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { templates } = await api.get('/notifications/templates');
      setTemplates(templates);
    } finally {
      setLoading(false);
    }
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
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5"><Bell size={14} /> Notification templates</h3>
      <p className="text-xs text-slate-500 mb-3">Customize the message sent for each event. Use <code>{'{{number}}'}</code>, <code>{'{{title}}'}</code> placeholders.</p>

      {!loading && templates.length > 0 && (
        <div className="space-y-2 mb-4">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-slate-700 dark:text-slate-200">{t.event.replace('_', ' ')} <span className="text-xs text-slate-400">({t.channel})</span></div>
                <div className="text-xs text-slate-500 truncate">{t.body}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => toggle(t)} className={`badge ${t.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}`}>{t.enabled ? 'enabled' : 'disabled'}</button>
                <button onClick={() => remove(t.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <Select
          value={form.event} onChange={(v) => setForm({ ...form, event: v })}
          options={EVENTS.map((ev) => ({ value: ev, label: ev.replace('_', ' ') }))}
        />
        <Select value={form.channel} onChange={(v) => setForm({ ...form, channel: v })} options={['in_app', 'email', 'slack']} />
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
  { value: 'email_smtp', label: 'Email (real SMTP delivery)' },
  { value: 'jira', label: 'Jira (simulated in this build)' },
  { value: 'http_api', label: 'API credential (for workflow "Call an external API")' },
];

const API_AUTH_TYPES = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth (username/password)' },
  { value: 'api_key', label: 'Custom header (API key)' },
];

function IntegrationModal({ initial, onClose, onSaved }) {
  const cfg = initial?.config || {};
  const [type, setType] = useState(initial?.type || 'slack');
  const [name, setName] = useState(initial?.name || '');
  const [webhookUrl, setWebhookUrl] = useState(cfg.webhook_url || '');
  const [smtp, setSmtp] = useState({
    host: cfg.host || '', port: cfg.port || 587, secure: !!cfg.secure, user: cfg.user || '', pass: '',
    from: cfg.from || '', to_default: cfg.to_default || '',
  });
  const [apiAuth, setApiAuth] = useState({
    auth_type: cfg.auth_type || 'bearer', token: '', username: cfg.username || '', password: '', header_name: cfg.header_name || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let config;
      if (['slack', 'teams', 'webhook', 'jira'].includes(type)) {
        config = { webhook_url: webhookUrl };
      } else if (type === 'http_api') {
        config = { auth_type: apiAuth.auth_type };
        if (apiAuth.auth_type === 'basic') {
          config.username = apiAuth.username;
          // Same "only send if changed" pattern as SMTP's password below.
          if (apiAuth.password) config.password = apiAuth.password;
        } else {
          if (apiAuth.auth_type === 'api_key') config.header_name = apiAuth.header_name;
          if (apiAuth.token) config.token = apiAuth.token;
        }
      } else {
        config = { host: smtp.host, port: Number(smtp.port) || 587, secure: smtp.secure, user: smtp.user, from: smtp.from, to_default: smtp.to_default };
        // Only send `pass` when the user actually typed a new one — the server
        // merges this onto the existing config, so omitting it here preserves
        // whatever password was saved previously instead of wiping it.
        if (smtp.pass) config.pass = smtp.pass;
      }
      if (initial?.id) await api.patch(`/integrations/${initial.id}`, { name, config, type });
      else await api.post('/integrations', { type, name, config });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit integration' : 'Connect integration'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Type</label>
          <Select value={type} onChange={setType} disabled={!!initial?.id} options={TYPES} />
        </div>
        <div>
          <label className="label">Name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #it-alerts" />
        </div>

        {['slack', 'teams', 'webhook', 'jira'].includes(type) && (
          <div>
            <label className="label">Webhook URL</label>
            <input className="input" required value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
          </div>
        )}

        {type === 'email_smtp' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">SMTP host</label>
                <input className="input" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.yourprovider.com" />
              </div>
              <div>
                <label className="label">Port</label>
                <input type="number" className="input" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} />
              Use TLS (port 465)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Username</label>
                <input className="input" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
              </div>
              <div>
                <label className="label">Password</label>
                <input type="password" className="input" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} placeholder={initial?.id ? 'Leave blank to keep current' : ''} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">From address</label>
                <input className="input" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder="itsm@yourcompany.com" />
              </div>
              <div>
                <label className="label">Default recipient (fallback)</label>
                <input className="input" value={smtp.to_default} onChange={(e) => setSmtp({ ...smtp, to_default: e.target.value })} placeholder="helpdesk@yourcompany.com" />
              </div>
            </div>
            <p className="text-xs text-slate-400">Leave these blank for now and fill them in later — the integration will simply not send until configured.</p>
          </div>
        )}

        {type === 'http_api' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Stores a credential (encrypted at rest) that a workflow's "Call an external API" action can attach to its request. Not tied to any single URL — the URL is set per action.
            </p>
            <div>
              <label className="label">Auth type</label>
              <Select value={apiAuth.auth_type} onChange={(v) => setApiAuth({ ...apiAuth, auth_type: v })} options={API_AUTH_TYPES} />
            </div>
            {apiAuth.auth_type === 'basic' ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Username</label>
                  <input className="input" value={apiAuth.username} onChange={(e) => setApiAuth({ ...apiAuth, username: e.target.value })} />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input type="password" className="input" value={apiAuth.password} onChange={(e) => setApiAuth({ ...apiAuth, password: e.target.value })} placeholder={initial?.id ? 'Leave blank to keep current' : ''} />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {apiAuth.auth_type === 'api_key' && (
                  <div>
                    <label className="label">Header name</label>
                    <input className="input" placeholder="e.g. X-API-Key" value={apiAuth.header_name} onChange={(e) => setApiAuth({ ...apiAuth, header_name: e.target.value })} />
                  </div>
                )}
                <div>
                  <label className="label">{apiAuth.auth_type === 'api_key' ? 'Header value' : 'Bearer token'}</label>
                  <input type="password" className="input" value={apiAuth.token} onChange={(e) => setApiAuth({ ...apiAuth, token: e.target.value })} placeholder={initial?.id ? 'Leave blank to keep current' : ''} />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const TYPE_ICON = { slack: Slack, teams: Webhook, webhook: Webhook, email_smtp: Mail, jira: Webhook, http_api: Globe2 };

export default function Integrations() {
  const { user } = useAuth();
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | integration
  const [testing, setTesting] = useState('');
  const [testResult, setTestResult] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const { integrations } = await api.get('/integrations');
      setIntegrations(integrations);
    } finally {
      setLoading(false);
    }
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
      <PageHeader
        title="Integrations"
        description="Connect Slack, Teams, webhooks, email, ticketing tools & API credentials"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> Connect integration</button>}
      />

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}
      {!loading && integrations.length === 0 && (
        <EmptyState icon={Plug} description="No integrations connected yet." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {integrations.map((i) => {
          const Icon = TYPE_ICON[i.type] || Webhook;
          return (
            <div key={i.id} className="card p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center">
                    <Icon size={16} />
                  </div>
                  <div>
                    <div className="font-medium text-slate-800 dark:text-slate-100">{i.name}</div>
                    <div className="text-xs text-slate-500 capitalize">{i.type.replace('_', ' ')}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setModal(i)} className="text-slate-400 hover:text-brand-600"><Pencil size={15} /></button>
                  <button onClick={() => remove(i.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className={`badge ${i.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>{i.enabled ? 'Enabled' : 'Disabled'}</span>
                {i.type === 'http_api' ? (
                  <span className="text-xs text-slate-400">Used by workflow API-call actions</span>
                ) : (
                  <button onClick={() => test(i.id)} disabled={testing === i.id} className="btn-secondary text-xs">
                    {testing === i.id ? <Loader2 size={12} className="animate-spin" /> : null} Send test
                  </button>
                )}
              </div>
              {testResult[i.id] && (
                <div className={`mt-2 text-xs rounded-md px-2 py-1.5 flex items-center gap-1.5 ${testResult[i.id].ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
                  {testResult[i.id].ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {testResult[i.id].ok ? (testResult[i.id].simulated ? 'Simulated send OK' : 'Delivered successfully') : testResult[i.id].error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasPermission(user, 'notifications.manage') && <NotificationTemplatesPanel />}

      {modal && (
        <IntegrationModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
