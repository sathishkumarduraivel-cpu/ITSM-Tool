import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Loader2, Save, Send, Plus, Trash2, Pencil, Mail, Eye, Code2, ToggleLeft, ToggleRight,
  History, CheckCircle2, XCircle, Clock3, FlaskConical, Tag, MessageSquareText,
  Link2, Unlink, Inbox, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

const SUB_TABS = [
  { key: 'smtp', label: 'SMTP Settings', icon: Mail },
  { key: 'templates', label: 'Email Templates', icon: MessageSquareText },
  { key: 'canned', label: 'Canned Responses', icon: Tag },
  { key: 'log', label: 'Delivery Log', icon: History },
];

function insertAtCursor(el, snippet, value, setValue) {
  if (!el) { setValue(value + snippet); return; }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const next = value.slice(0, start) + snippet + value.slice(end);
  setValue(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = start + snippet.length;
  });
}

// ---- Inbound email -> ticket (only ever shown once a Microsoft mailbox is
// connected -- SMTP has no equivalent, since there's no generic "read this
// inbox" protocol this app could poll without knowing which one) ----------
function InboundEmailCard({ settings, onChange }) {
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [logs, setLogs] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      const { settings: s } = await api.patch('/email-settings/inbound', { inbound_enabled: !settings.inbound_enabled });
      onChange(s);
    } finally {
      setSaving(false);
    }
  };

  const checkNow = async () => {
    setChecking(true); setCheckResult(null);
    try {
      const result = await api.post('/email-settings/inbound/check-now', {});
      setCheckResult(result);
      if (showLog) loadLog();
    } catch (e) {
      setCheckResult({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  const loadLog = async () => {
    setShowLog(true);
    const { logs: rows } = await api.get('/email-settings/inbound/log');
    setLogs(rows);
  };

  const ACTION_META = {
    ticket_created: { label: 'ticket created', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
    comment_added: { label: 'reply matched', className: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' },
    error: { label: 'error', className: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' },
    skipped: { label: 'skipped', className: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
  };

  return (
    <div className="border-t border-slate-100 dark:border-slate-800 pt-3 mt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-2">
          <Inbox size={15} className="text-slate-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">Create tickets from incoming email</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Anyone who emails this mailbox gets a ticket automatically; a reply to a ticket email adds a comment instead of a duplicate.</p>
          </div>
        </div>
        <button onClick={toggle} disabled={saving} className="shrink-0" title={settings.inbound_enabled ? 'Turn off' : 'Turn on'}>
          {settings.inbound_enabled ? <ToggleRight size={24} className="text-emerald-500" /> : <ToggleLeft size={24} className="text-slate-300 dark:text-slate-600" />}
        </button>
      </div>
      {!!settings.inbound_enabled && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={checkNow} disabled={checking} className="btn-secondary text-xs">
              {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check now
            </button>
            <button onClick={loadLog} className="text-xs text-slate-400 hover:text-brand-600 dark:hover:text-brand-400">Recent activity</button>
            {settings.inbound_last_synced_at && <span className="text-[11px] text-slate-400">last checked {new Date(settings.inbound_last_synced_at).toLocaleString()}</span>}
          </div>
          {checkResult && !checkResult.error && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{checkResult.checked} email(s) checked — {checkResult.created} new ticket{checkResult.created === 1 ? '' : 's'}, {checkResult.commented} repl{checkResult.commented === 1 ? 'y' : 'ies'} matched{checkResult.skipped ? `, ${checkResult.skipped} skipped` : ''}.</p>
          )}
          {checkResult?.error && <p className="text-xs text-red-600 dark:text-red-400">{checkResult.error}</p>}
          {showLog && (
            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 text-xs space-y-1 max-h-40 overflow-y-auto">
              {!logs && <div className="text-slate-400">Loading…</div>}
              {logs?.length === 0 && <div className="text-slate-400">No inbound email processed yet.</div>}
              {logs?.map((l) => {
                const meta = ACTION_META[l.action] || ACTION_META.skipped;
                return (
                  <div key={l.id} className="flex items-center gap-2">
                    <span className={`badge shrink-0 ${meta.className}`}>{meta.label}</span>
                    <span className="text-slate-600 dark:text-slate-300 truncate flex-1">{l.subject || '(no subject)'}</span>
                    <span className="text-slate-400 truncate max-w-[140px] shrink-0">{l.from_email}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- SMTP Settings ----------------------------------------------------
function SmtpSettingsPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [notice, setNotice] = useState(null); // { type: 'success'|'error', text }

  const load = async () => {
    const { settings: s } = await api.get('/email-settings');
    setSettings(s);
    setForm({ ...s, password: '' });
  };
  useEffect(() => { load(); }, []);

  // Lands back here after the Microsoft OAuth redirect (routes/emailSettings.js's
  // callback can only reach the app via ?section=&mailboxConnected=/&mailboxError=
  // on a real HTTP redirect -- location.state doesn't survive that the way
  // client-side navigate() state does). Shown once, then scrubbed from the
  // URL so refreshing the page doesn't replay the toast.
  useEffect(() => {
    const connected = searchParams.get('mailboxConnected');
    const err = searchParams.get('mailboxError');
    if (connected) { setNotice({ type: 'success', text: `Connected ${connected} — outbound email now sends from this mailbox.` }); load(); }
    else if (err) { setNotice({ type: 'error', text: err }); }
    if (connected || err) {
      const next = new URLSearchParams(searchParams);
      next.delete('mailboxConnected'); next.delete('mailboxError');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setSaved(false); };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError(''); setSaved(false);
    try {
      const { settings: s } = await api.put('/email-settings', form);
      setSettings(s);
      setForm({ ...s, password: '' });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testTo) return;
    setTesting(true); setTestResult(null);
    try {
      await api.post('/email-settings/test', { ...form, to: testTo });
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const connectMicrosoft = async () => {
    setConnecting(true); setConnectError('');
    try {
      const { url } = await api.post('/email-settings/microsoft/start', {});
      window.location.href = url;
    } catch (e) {
      setConnectError(e.message);
      setConnecting(false);
    }
  };

  const disconnectMicrosoft = async () => {
    if (!confirm('Disconnect this mailbox? Outbound email will stop sending until you connect another mailbox or configure SMTP.')) return;
    const { settings: s } = await api.post('/email-settings/microsoft/disconnect', {});
    setSettings(s);
    setForm({ ...s, password: '' });
  };

  if (!form) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  const isMicrosoft = settings.mailbox_provider === 'microsoft' && settings.graphConnected;

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`text-sm rounded-lg px-3 py-2 flex items-center gap-2 ${notice.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
          {notice.type === 'success' ? <CheckCircle2 size={15} className="shrink-0" /> : <AlertTriangle size={15} className="shrink-0" />}
          {notice.text}
          <button onClick={() => setNotice(null)} className="ml-auto text-xs opacity-70 hover:opacity-100 shrink-0">Dismiss</button>
        </div>
      )}

      {isMicrosoft ? (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center text-brand-600 dark:text-brand-400 shrink-0"><Mail size={17} /></div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{settings.graph_mailbox_email}</div>
                <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 size={11} /> Connected — sending live mail through Microsoft 365</div>
              </div>
            </div>
            <button onClick={disconnectMicrosoft} className="btn-secondary text-xs shrink-0"><Unlink size={12} /> Disconnect</button>
          </div>
          <InboundEmailCard settings={settings} onChange={(s) => { setSettings(s); setForm({ ...s, password: '' }); }} />
        </div>
      ) : (
        <div className="card p-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5"><Link2 size={14} /> Connect a Microsoft 365 mailbox</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-md">Send real mail through a real mailbox (e.g. support@yourcompany.com) in one click — no SMTP host or password to type, and it can turn incoming mail into tickets too. Reuses your Microsoft Single Sign-On setup.</p>
            </div>
            <button onClick={connectMicrosoft} disabled={connecting} className="btn-primary text-xs shrink-0">
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Connect with Microsoft
            </button>
          </div>
          {connectError && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{connectError}</p>}
        </div>
      )}

      {!isMicrosoft && (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <form onSubmit={save} className="lg:col-span-2 card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Outbound mail server</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Every ticket-lifecycle email in this workspace is sent through this SMTP profile.</p>
          </div>
          <button type="button" onClick={() => set('enabled', !form.enabled)} className="shrink-0" title={form.enabled ? 'Disable outbound email' : 'Enable outbound email'}>
            {form.enabled ? <ToggleRight size={26} className="text-emerald-500" /> : <ToggleLeft size={26} className="text-slate-300 dark:text-slate-600" />}
          </button>
        </div>

        {!form.enabled && (
          <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2">
            Email is currently off — every lifecycle event still "sends," but is only logged to the Delivery Log as simulated, not actually delivered.
          </p>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">SMTP host</label>
            <input className="input" placeholder="smtp.yourcompany.com" value={form.host || ''} onChange={(e) => set('host', e.target.value)} />
          </div>
          <div>
            <label className="label">Port</label>
            <input type="number" className="input" value={form.port || 587} onChange={(e) => set('port', e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={!!form.secure} onChange={(e) => set('secure', e.target.checked)} /> Use TLS/SSL (port 465)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Username</label>
            <input className="input" autoComplete="off" value={form.username || ''} onChange={(e) => set('username', e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" className="input" autoComplete="new-password" placeholder={settings?.hasPassword ? '•••••••• (leave blank to keep)' : ''} value={form.password || ''} onChange={(e) => set('password', e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">From name</label>
            <input className="input" placeholder="Your Company IT Support" value={form.from_name || ''} onChange={(e) => set('from_name', e.target.value)} />
          </div>
          <div>
            <label className="label">From address</label>
            <input className="input" placeholder="support@yourcompany.com" value={form.from_email || ''} onChange={(e) => set('from_email', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Reply-to <span className="text-slate-400 font-normal">(optional)</span></label>
          <input className="input" value={form.reply_to || ''} onChange={(e) => set('reply_to', e.target.value)} />
        </div>
        <div>
          <label className="label">Footer <span className="text-slate-400 font-normal">— appended to every email (HTML allowed)</span></label>
          <textarea className="input font-mono text-xs" rows={3} placeholder="Your Company IT · support@yourcompany.com" value={form.footer_html || ''} onChange={(e) => set('footer_html', e.target.value)} />
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex items-center gap-2 pt-1">
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save settings
          </button>
          {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 size={13} /> Saved</span>}
        </div>
      </form>

      <div className="card p-4 space-y-3 h-fit">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5"><FlaskConical size={15} /> Test connection</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">Sends a real test email using whatever is currently in the form on the left — you don't need to save first.</p>
        <input className="input text-sm" type="email" placeholder="you@yourcompany.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <button type="button" onClick={sendTest} disabled={testing || !testTo} className="btn-secondary w-full justify-center">
          {testing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send test email
        </button>
        {testResult && (
          <div className={`text-xs rounded-lg px-3 py-2 flex items-start gap-1.5 ${testResult.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
            {testResult.ok ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <XCircle size={14} className="shrink-0 mt-0.5" />}
            {testResult.ok ? 'Sent — check the inbox.' : testResult.error}
          </div>
        )}
      </div>
    </div>
      )}
    </div>
  );
}

// ---- Email Templates ---------------------------------------------------
const AUDIENCE_META = {
  requester: { label: 'Requester', className: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' },
  agent: { label: 'Agent', className: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400' },
  approver: { label: 'Approver', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  admin: { label: 'Admin', className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' },
};

function TemplateEditor({ tpl, onSaved }) {
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body_html);
  const [enabled, setEnabled] = useState(!!tpl.enabled);
  const [mode, setMode] = useState('code'); // code | preview
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const subjectRef = useRef(null);
  const bodyRef = useRef(null);
  const lastFocused = useRef('body');

  useEffect(() => {
    setSubject(tpl.subject); setBody(tpl.body_html); setEnabled(!!tpl.enabled);
    setMode('code'); setPreview(null); setSaved(false); setError(''); setTestResult(null);
  }, [tpl.id]);

  useEffect(() => {
    if (mode !== 'preview') return;
    api.post(`/email-templates/${tpl.id}/preview`, { subject, body_html: body }).then(setPreview);
  }, [mode, subject, body, tpl.id]);

  const insertVar = (v) => {
    const snippet = `{{${v}}}`;
    if (lastFocused.current === 'subject') insertAtCursor(subjectRef.current, snippet, subject, setSubject);
    else insertAtCursor(bodyRef.current, snippet, body, setBody);
  };

  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      await api.patch(`/email-templates/${tpl.id}`, { subject, body_html: body, enabled });
      onSaved();
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (!testTo) return;
    setTesting(true); setTestResult(null);
    try {
      await api.post(`/email-templates/${tpl.id}/send-test`, { to: testTo });
      setTestResult({ ok: true });
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const audience = AUDIENCE_META[tpl.audience] || { label: tpl.audience, className: 'bg-slate-100 text-slate-600' };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{tpl.name}</h3>
            <span className={`badge ${audience.className}`}>{audience.label}</span>
            <code className="text-[11px] text-slate-400 font-mono">{tpl.key}</code>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{tpl.category}</p>
        </div>
        <button type="button" onClick={() => setEnabled((v) => !v)} className="shrink-0" title={enabled ? 'Disable this email' : 'Enable this email'}>
          {enabled ? <ToggleRight size={24} className="text-emerald-500" /> : <ToggleLeft size={24} className="text-slate-300 dark:text-slate-600" />}
        </button>
      </div>

      <div>
        <label className="label">Subject</label>
        <input
          ref={subjectRef} className="input font-mono text-xs" value={subject}
          onFocus={() => { lastFocused.current = 'subject'; }}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-slate-400 mr-0.5">Insert:</span>
        {(tpl.variables || []).map((v) => (
          <button key={v} type="button" onClick={() => insertVar(v)} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-400">
            {`{{${v}}}`}
          </button>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="label mb-0">Body</label>
          <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5">
            <button type="button" onClick={() => setMode('code')} className={`text-xs px-2 py-1 rounded-md flex items-center gap-1 ${mode === 'code' ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-700 dark:text-slate-200' : 'text-slate-500'}`}><Code2 size={12} /> HTML</button>
            <button type="button" onClick={() => setMode('preview')} className={`text-xs px-2 py-1 rounded-md flex items-center gap-1 ${mode === 'preview' ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-700 dark:text-slate-200' : 'text-slate-500'}`}><Eye size={12} /> Preview</button>
          </div>
        </div>
        {mode === 'code' ? (
          <textarea
            ref={bodyRef} className="input font-mono text-xs" rows={11} value={body}
            onFocus={() => { lastFocused.current = 'body'; }}
            onChange={(e) => setBody(e.target.value)}
          />
        ) : (
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white" style={{ height: 268 }}>
            {preview ? (
              <>
                <div className="text-xs text-slate-500 bg-slate-50 border-b border-slate-200 px-3 py-2 truncate">
                  <strong className="text-slate-700">Subject:</strong> {preview.subject}
                </div>
                <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="w-full border-0" style={{ height: 232 }} />
              </>
            ) : (
              <div className="text-slate-400 text-xs text-center py-10">Rendering preview…</div>
            )}
          </div>
        )}
        <p className="text-[11px] text-slate-400 mt-1">Preview and test sends use sample data — actual emails fill these variables from the real ticket.</p>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex items-center justify-between flex-wrap gap-3 pt-1">
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save template
          </button>
          {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 size={13} /> Saved</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <input type="email" placeholder="Send test to…" className="input text-xs py-1.5 w-44" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button type="button" onClick={sendTest} disabled={testing || !testTo} className="btn-secondary text-xs">
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Test
          </button>
          {testResult && (testResult.ok
            ? <CheckCircle2 size={16} className="text-emerald-500" />
            : <XCircle size={16} className="text-red-500" title={testResult.error} />)}
        </div>
      </div>
    </div>
  );
}

function TemplatesPanel() {
  const [templates, setTemplates] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const load = async () => {
    const { templates: rows } = await api.get('/email-templates');
    setTemplates(rows);
    setSelectedId((id) => (id && rows.some((r) => r.id === id) ? id : rows[0]?.id));
  };
  useEffect(() => { load(); }, []);

  if (!templates) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  const byCategory = templates.reduce((acc, t) => { (acc[t.category] ||= []).push(t); return acc; }, {});
  const selected = templates.find((t) => t.id === selectedId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="card p-2 space-y-3 h-fit">
        {Object.entries(byCategory).map(([category, rows]) => (
          <div key={category}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 px-2 py-1">{category}</div>
            <div className="space-y-0.5">
              {rows.map((t) => (
                <button
                  key={t.id} onClick={() => setSelectedId(t.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-sm flex items-center justify-between gap-2 ${selectedId === t.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <span className="truncate">{t.name}</span>
                  {!t.enabled && <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" title="Disabled" />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="lg:col-span-2 card p-4">
        {selected && <TemplateEditor key={selected.id} tpl={selected} onSaved={load} />}
      </div>
    </div>
  );
}

// ---- Canned Responses ---------------------------------------------------
function CannedResponseModal({ initial, teams, onClose, onSaved }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [shortcut, setShortcut] = useState(initial?.shortcut || '');
  const [category, setCategory] = useState(initial?.category || '');
  const [team, setTeam] = useState(initial?.team || '');
  const [body, setBody] = useState(initial?.body_html || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = { title, shortcut: shortcut || null, category: category || null, team: team || null, body_html: body };
      if (initial?.id) await api.patch(`/canned-responses/${initial.id}`, payload);
      else await api.post('/canned-responses', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit canned response' : 'New canned response'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Title</label>
          <input className="input" required autoFocus placeholder="e.g. Password reset instructions" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Shortcut <span className="text-slate-400 font-normal">(optional)</span></label>
            <input className="input" placeholder="/pwreset" value={shortcut} onChange={(e) => setShortcut(e.target.value)} />
          </div>
          <div>
            <label className="label">Category <span className="text-slate-400 font-normal">(optional)</span></label>
            <input className="input" placeholder="Account Access" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Team <span className="text-slate-400 font-normal">— leave unset to share with every team</span></label>
          <Select value={team} onChange={setTeam} placeholder="All teams" options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.name, label: t.name }))]} />
        </div>
        <div>
          <label className="label">Response text</label>
          <textarea className="input" rows={6} required placeholder="Hi {{name}}, ..." value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CannedResponsesPanel() {
  const [responses, setResponses] = useState(null);
  const [teams, setTeams] = useState([]);
  const [modal, setModal] = useState(null);

  const load = async () => {
    const [{ responses: rows }, { groups }] = await Promise.all([api.get('/canned-responses'), api.get('/groups')]);
    setResponses(rows);
    setTeams(groups);
  };
  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this canned response?')) return;
    await api.del(`/canned-responses/${id}`);
    load();
  };

  if (!responses) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg">
          Reusable reply snippets agents can drop straight into a ticket's Reply composer — optionally scoped to one team's queue.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary text-xs shrink-0"><Plus size={13} /> New response</button>
      </div>

      {responses.length === 0 ? (
        <EmptyState icon={Tag} title="No canned responses yet" description="Create a first-response template your agents can reuse across tickets." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {responses.map((r) => (
            <div key={r.id} className="px-4 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.title}</span>
                  {r.shortcut && <code className="text-[11px] text-slate-400 font-mono">{r.shortcut}</code>}
                  {r.team && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{r.team}</span>}
                  {r.category && <span className="text-[11px] text-slate-400">{r.category}</span>}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{r.body_html}</p>
              </div>
              <span className="text-[11px] text-slate-400 shrink-0">{r.usage_count} uses</span>
              <button onClick={() => setModal(r)} className="text-slate-400 hover:text-brand-600 shrink-0" title="Edit"><Pencil size={15} /></button>
              <button onClick={() => remove(r.id)} className="text-slate-400 hover:text-red-500 shrink-0" title="Delete"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <CannedResponseModal initial={modal === 'new' ? null : modal} teams={teams} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}

// ---- Delivery Log ---------------------------------------------------
const STATUS_META = {
  sent: { label: 'Sent', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400', icon: CheckCircle2 },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400', icon: XCircle },
  simulated: { label: 'Simulated', className: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', icon: Clock3 },
};

function DeliveryLogPanel() {
  const [logs, setLogs] = useState(null);
  useEffect(() => { api.get('/email-templates/logs/recent').then(({ logs }) => setLogs(logs)); }, []);

  if (!logs) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  if (!logs.length) return <EmptyState icon={History} title="No emails sent yet" description="Every attempted send — sent, failed, or simulated — will show up here." />;

  return (
    <div className="card divide-y divide-slate-100 dark:divide-slate-800 overflow-x-auto">
      {logs.map((l) => {
        const meta = STATUS_META[l.status] || STATUS_META.simulated;
        const Icon = meta.icon;
        return (
          <div key={l.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
            <span className={`badge shrink-0 ${meta.className}`}><Icon size={11} /> {meta.label}</span>
            <span className="text-slate-700 dark:text-slate-200 truncate flex-1">{l.subject || '(no subject)'}</span>
            <span className="text-slate-400 text-xs truncate max-w-[180px]">{l.to_email}</span>
            {l.template_key && <code className="text-[11px] text-slate-400 font-mono shrink-0">{l.template_key}</code>}
            <span className="text-slate-300 dark:text-slate-600 text-xs font-mono shrink-0">{new Date(l.created_at).toLocaleString()}</span>
          </div>
        );
      })}
      {logs.some((l) => l.status === 'failed') && (
        <div className="px-4 py-2 text-xs text-slate-400">Hover over a failed row's subject to see the error in a future pass — for now, check the server log.</div>
      )}
    </div>
  );
}

export default function EmailConfigTab() {
  const [tab, setTab] = useState('smtp');
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 flex-wrap">
        {SUB_TABS.map((t) => (
          <button
            key={t.key} onClick={() => setTab(t.key)}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${tab === t.key ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'smtp' && <SmtpSettingsPanel />}
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'canned' && <CannedResponsesPanel />}
      {tab === 'log' && <DeliveryLogPanel />}
    </div>
  );
}
