import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckSquare, Check, X, Loader2, UserCheck, CalendarClock, Trash2, Plus, AlertTriangle, ChevronDown,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { TypeBadge } from '../components/Badge.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import Select from '../components/Select.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const TYPES = ['incident', 'request', 'problem', 'change'];

const window_ = (d) => {
  if (d.starts_at && d.ends_at) return `${d.starts_at} to ${d.ends_at}`;
  if (d.starts_at) return `from ${d.starts_at}`;
  if (d.ends_at) return `until ${d.ends_at}`;
  return 'until revoked';
};

// Cover while an approver is away. Lives on this page rather than in Admin
// Settings because the person who needs it is the approver themselves, and
// they are already here looking at the queue they are about to leave behind.
function DelegationPanel({ users, onChanged }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState({ to_user_id: '', starts_at: '', ends_at: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/approvals/delegations${showAll ? '?scope=all' : ''}`));
      setError('');
    } catch (e) { setError(e.message); }
  }, [showAll]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.to_user_id) return;
    setBusy(true); setError('');
    try {
      await api.post('/approvals/delegations', {
        to_user_id: form.to_user_id,
        starts_at: form.starts_at || undefined,
        ends_at: form.ends_at || undefined,
        reason: form.reason.trim() || undefined,
      });
      setForm({ to_user_id: '', starts_at: '', ends_at: '', reason: '' });
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const revoke = async (d) => {
    if (!window.confirm(`End ${d.to_name}'s cover of ${d.from_name}'s approvals? Anything still pending goes back to ${d.from_name} alone.`)) return;
    setError('');
    try { await api.del(`/approvals/delegations/${d.id}`); await load(); onChanged?.(); }
    catch (e) { setError(e.message); }
  };

  const mine = data?.mine?.filter((d) => !d.revoked_at) || [];
  const toMe = data?.to_me?.filter((d) => !d.revoked_at) || [];

  return (
    <div className="card p-0 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <UserCheck size={15} className="shrink-0 text-slate-400" />
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">Delegation</span>
          <span className="truncate text-xs text-slate-400">
            {mine.length
              ? `your approvals are covered by ${mine.map((d) => d.to_name).join(', ')}`
              : 'hand your approvals to somebody while you are away'}
          </span>
        </span>
        <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-slate-200/70 px-4 py-4 dark:border-white/[0.06]">
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">While you are away</h3>
            {mine.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">Nobody is covering your approvals.</p>
            ) : (
              <div className="mt-2 space-y-1">
                {mine.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs dark:bg-slate-800/60">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{d.to_name}</span>
                    <span className="flex items-center gap-1 text-slate-400"><CalendarClock size={11} /> {window_(d)}</span>
                    {!d.in_force && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">not yet active</span>}
                    {d.reason && <span className="italic text-slate-400">&ldquo;{d.reason}&rdquo;</span>}
                    <button onClick={() => revoke(d)} className="ml-auto text-slate-400 hover:text-red-500" title="End this cover">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={submit} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="label">Who covers your approvals</label>
                <Select
                  value={form.to_user_id} onChange={(v) => setForm({ ...form, to_user_id: v })}
                  placeholder="Choose somebody"
                  options={users.filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.email ? `${u.name} — ${u.email}` : u.name }))}
                />
              </div>
              <div>
                <label className="label">From <span className="font-normal text-slate-400">(optional)</span></label>
                <input type="date" className="input" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
              </div>
              <div>
                <label className="label">Until <span className="font-normal text-slate-400">(optional)</span></label>
                <input type="date" className="input" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
              </div>
              <div>
                <label className="label">Reason <span className="font-normal text-slate-400">(optional)</span></label>
                <input className="input" placeholder="Annual leave" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </div>
            </div>
            <p className="text-[11px] text-slate-400">
              Leave both dates empty and the cover runs until you end it. They decide as themselves &mdash; every decision records
              that they were covering for you.
            </p>
            <div className="flex justify-end">
              <button type="submit" disabled={busy || !form.to_user_id} className="btn-primary text-xs disabled:opacity-40">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Delegate
              </button>
            </div>
          </form>

          {toMe.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">You are covering for</h3>
              <div className="mt-2 space-y-1">
                {toMe.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs dark:bg-amber-500/10">
                    <span className="font-medium text-amber-900 dark:text-amber-200">{d.from_name}</span>
                    <span className="flex items-center gap-1 text-amber-700/70 dark:text-amber-300/70"><CalendarClock size={11} /> {window_(d)}</span>
                    {!d.in_force && <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200">not yet active</span>}
                    <button onClick={() => revoke(d)} className="ml-auto text-amber-700/60 hover:text-red-500 dark:text-amber-300/60" title="Decline this cover">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {user?.role === 'admin' && (
            <div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                Show every delegation in this workspace
              </label>
              {showAll && (
                <div className="mt-2 space-y-1">
                  {(data?.all || []).length === 0 ? (
                    <p className="text-xs text-slate-400">Nobody has arranged cover.</p>
                  ) : (data.all || []).map((d) => (
                    <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs dark:bg-slate-800/60">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{d.from_name}</span>
                      <span className="text-slate-400">&rarr;</span>
                      <span className="font-medium text-slate-700 dark:text-slate-200">{d.to_name}</span>
                      <span className="flex items-center gap-1 text-slate-400"><CalendarClock size={11} /> {window_(d)}</span>
                      {!d.in_force && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">inactive</span>}
                      <button onClick={() => revoke(d)} className="ml-auto text-slate-400 hover:text-red-500" title="End this cover">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const [tab, setTab] = useState('pending');
  const [type, setType] = useState('');
  const [requesterId, setRequesterId] = useState('');
  const [users, setUsers] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [actingFor, setActingFor] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [decideError, setDecideError] = useState('');
  const [comments, setComments] = useState({});
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams({ status: tab });
      if (type) params.set('type', type);
      if (requesterId) params.set('requester_id', requesterId);
      const data = await api.get(`/approvals?${params.toString()}`);
      setApprovals(data.approvals);
      setActingFor(data.acting_for || []);
    } catch (e) {
      // Without this catch, a failed request left `loading` stuck true
      // forever -- agents/admins couldn't see or act on any pending
      // approval, with nothing telling them why.
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tab, type, requesterId]);
  useEffect(() => { api.get('/auth/users').then(({ users }) => setUsers(users)); }, []);

  const decide = async (id, status) => {
    setBusy(id);
    setDecideError('');
    try {
      await api.post(`/approvals/${id}/decide`, { status, comments: comments[id] || '' });
      load();
    } catch (e) {
      // The endpoint can legitimately refuse now -- it is not your approval,
      // it is your own request, or somebody already decided it. Swallowing
      // that left the button looking as though it had worked.
      setDecideError(e.message);
    } finally {
      setBusy('');
    }
  };

  const coveringName = (approverId) => actingFor.find((d) => d.from_user_id === approverId)?.from_name;

  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" description="Service catalog requests & change advisory board sign-offs" />

      <DelegationPanel users={users} onChanged={load} />

      {actingFor.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <UserCheck size={15} className="mt-0.5 shrink-0" />
          <span>
            You are covering approvals for <strong>{actingFor.map((d) => d.from_name).join(', ')}</strong>.
            Their pending approvals appear below alongside your own.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {['pending', 'approved', 'rejected'].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={t === tab ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />
        <Select
          size="sm" className="w-auto" value={type} onChange={setType}
          options={[{ value: '', label: 'All types' }, ...TYPES.map((t) => ({ value: t, label: t }))]}
        />
        <Select
          size="sm" className="w-auto" value={requesterId} onChange={setRequesterId}
          options={[{ value: '', label: 'All requesters' }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
        />
      </div>

      {decideError && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {decideError}
        </div>
      )}
      {loadError && !loading && (
        <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button onClick={load} className="btn-secondary text-xs shrink-0">Retry</button>
        </div>
      )}
      {loading && <SkeletonRows count={3} />}
      {!loading && !loadError && approvals.length === 0 && (
        <EmptyState icon={CheckSquare} description={`Nothing ${tab} right now.`} />
      )}

      <div className="space-y-2">
        {approvals.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <button onClick={() => navigate(`/tickets/${a.ticket_id}`)} className="font-medium text-slate-800 dark:text-slate-100 hover:underline flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">{a.number}</span>
                  <TypeBadge type={a.type} />
                  {a.title}
                </button>
                <div className="text-xs text-slate-500 mt-0.5">
                  Requested by {a.requester_name || 'Unknown'} · needs {a.approver_role || 'an'} approval
                </div>
                {/* Deciding as somebody's cover is a different act from
                    deciding your own, so the queue says so before you click. */}
                {a.via_delegation && (
                  <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    <UserCheck size={11} /> covering for {coveringName(a.approver_id) || 'another approver'}
                  </div>
                )}
              </div>
              {tab === 'pending' && (
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    className="input w-40 text-xs"
                    placeholder="Comment (optional)"
                    value={comments[a.id] || ''}
                    onChange={(e) => setComments({ ...comments, [a.id]: e.target.value })}
                  />
                  <button onClick={() => decide(a.id, 'rejected')} disabled={busy === a.id} className="btn-danger text-xs">
                    {busy === a.id ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Reject
                  </button>
                  <button onClick={() => decide(a.id, 'approved')} disabled={busy === a.id} className="btn-primary text-xs">
                    {busy === a.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve
                  </button>
                </div>
              )}
              {tab !== 'pending' && a.comments && <span className="text-xs text-slate-500 italic">&ldquo;{a.comments}&rdquo;</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
