import { useEffect, useState } from 'react';
import { Link2, X, UploadCloud, DownloadCloud, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { platformMeta, SYNC_STATUS_STYLE } from '../lib/externalPlatformConstants.js';
import Select from './Select.jsx';

// Each platform identifies a record differently in its own API -- shown as
// both a placeholder and an explicit hint (not just the placeholder alone,
// since a placeholder that looks like a real value invites someone to type
// it literally rather than substitute their own record's id).
const EXISTING_ID_PLACEHOLDER = { servicenow: 'e.g. INC0010010', jira: 'Issue key', freshservice: 'Ticket id number', servicedeskplus: 'Request id number' };
const EXISTING_ID_HINT = {
  servicenow: 'Either the ticket number (INC0010010) or the sys_id works — we look it up either way.',
  jira: 'The issue key shown in Jira, e.g. PROJ-123.',
  freshservice: "The ticket's numeric id — the number after the # in Freshservice, e.g. 456.",
  servicedeskplus: "The request's numeric id, shown in its ServiceDesk Plus URL (woID=...).",
};

function LinkRow({ ticketId, link, onChanged }) {
  const [busy, setBusy] = useState('');
  const meta = platformMeta(link.platform);
  const Icon = meta.icon;

  const push = async () => {
    setBusy('push');
    try { await api.post(`/tickets/${ticketId}/external-links/${link.id}/push`, {}); await onChanged(); } finally { setBusy(''); }
  };
  const pull = async () => {
    setBusy('pull');
    try { await api.post(`/tickets/${ticketId}/external-links/${link.id}/pull`, {}); await onChanged(); }
    catch (e) { alert(e.message); }
    finally { setBusy(''); }
  };
  const unlink = async () => {
    if (!confirm(`Unlink from ${link.connection_name}? This only stops tracking it here — nothing is deleted on their side.`)) return;
    await api.del(`/tickets/${ticketId}/external-links/${link.id}`);
    onChanged();
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-md px-2 py-1.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 text-sm">
          <Icon size={13} className="text-slate-400 shrink-0" />
          {link.external_url ? (
            <a href={link.external_url} target="_blank" rel="noreferrer" className="font-mono text-brand-600 dark:text-brand-400 hover:underline truncate flex items-center gap-1">
              {link.external_number} <ExternalLink size={11} />
            </a>
          ) : (
            <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{link.external_number}</span>
          )}
        </div>
        <button onClick={unlink} className="text-slate-400 hover:text-red-500 shrink-0"><X size={13} /></button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`badge ${SYNC_STATUS_STYLE[link.sync_status] || SYNC_STATUS_STYLE.pending}`}>{link.sync_status}</span>
        <div className="flex items-center gap-1">
          <button onClick={push} disabled={!!busy} className="btn-ghost !px-1.5 !py-1 text-xs" title="Push our latest state out">
            {busy === 'push' ? <Loader2 size={11} className="animate-spin" /> : <UploadCloud size={11} />}
          </button>
          <button onClick={pull} disabled={!!busy} className="btn-ghost !px-1.5 !py-1 text-xs" title="Pull their latest state in">
            {busy === 'pull' ? <Loader2 size={11} className="animate-spin" /> : <DownloadCloud size={11} />}
          </button>
        </div>
      </div>
      {link.last_synced_at && (
        <p className="text-[11px] text-slate-400">
          {link.sync_status === 'error' ? link.last_error : `Last synced ${new Date(link.last_synced_at).toLocaleString()} (${link.last_direction})`}
        </p>
      )}
    </div>
  );
}

export default function ExternalLinksPanel({ ticketId, links, onChanged }) {
  const [connections, setConnections] = useState([]);
  const [connectionId, setConnectionId] = useState('');
  const [existingId, setExistingId] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/external-connections').then((d) => setConnections(d.connections.filter((c) => c.enabled))).catch(() => setConnections([]));
  }, []);

  const createThere = async () => {
    if (!connectionId) return;
    setLinking(true);
    setError('');
    try {
      await api.post(`/tickets/${ticketId}/external-links`, { connection_id: connectionId, mode: 'create' });
      setConnectionId('');
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  };

  const linkExisting = async () => {
    if (!connectionId || !existingId.trim()) return;
    setLinking(true);
    setError('');
    try {
      await api.post(`/tickets/${ticketId}/external-links`, { connection_id: connectionId, mode: 'link', external_id: existingId.trim() });
      setConnectionId('');
      setExistingId('');
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5"><Link2 size={14} /> External links</h3>

      <div className="space-y-1.5 mb-2">
        {links.length === 0 && <p className="text-xs text-slate-400">Not linked to any external platform.</p>}
        {links.map((l) => <LinkRow key={l.id} ticketId={ticketId} link={l} onChanged={onChanged} />)}
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-500/10 rounded-md px-2 py-1.5 mb-2">{error}</div>}

      {connections.length === 0 ? (
        <p className="text-xs text-slate-400">No external connections configured — set one up under Configuration → External Connections.</p>
      ) : (
        <div className="space-y-1.5">
          <Select
            value={connectionId} onChange={setConnectionId}
            options={[
              { value: '', label: 'Link to platform…' },
              ...connections.map((c) => ({ value: c.id, label: `${c.name} (${c.platform})` })),
            ]}
          />
          {connectionId && (
            <div className="flex items-center gap-1.5">
              <button onClick={createThere} disabled={linking} className="btn-secondary text-xs flex-1">
                {linking ? <Loader2 size={11} className="animate-spin" /> : null} Create new there
              </button>
            </div>
          )}
          {connectionId && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <input
                  className="input text-sm flex-1"
                  placeholder={EXISTING_ID_PLACEHOLDER[connections.find((c) => c.id === connectionId)?.platform] || '…or paste an existing id'}
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                />
                <button onClick={linkExisting} disabled={linking || !existingId.trim()} className="btn-secondary text-xs shrink-0">Link</button>
              </div>
              <p className="text-[11px] text-slate-400">{EXISTING_ID_HINT[connections.find((c) => c.id === connectionId)?.platform]}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
