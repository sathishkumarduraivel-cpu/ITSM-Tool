import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, Check, X, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { TypeBadge } from '../components/Badge.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const TYPES = ['incident', 'request', 'problem', 'change'];

export default function Approvals() {
  const [tab, setTab] = useState('pending');
  const [type, setType] = useState('');
  const [requesterId, setRequesterId] = useState('');
  const [users, setUsers] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [comments, setComments] = useState({});
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ status: tab });
    if (type) params.set('type', type);
    if (requesterId) params.set('requester_id', requesterId);
    const { approvals } = await api.get(`/approvals?${params.toString()}`);
    setApprovals(approvals);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab, type, requesterId]);
  useEffect(() => { api.get('/auth/users').then(({ users }) => setUsers(users)); }, []);

  const decide = async (id, status) => {
    setBusy(id);
    try {
      await api.post(`/approvals/${id}/decide`, { status, comments: comments[id] || '' });
      load();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" description="Service catalog requests & change advisory board sign-offs" />

      <div className="flex flex-wrap items-center gap-2">
        {['pending', 'approved', 'rejected'].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={t === tab ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />
        <select className="input w-auto text-xs py-1.5" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input w-auto text-xs py-1.5" value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>
          <option value="">All requesters</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>

      {loading && <SkeletonRows count={3} />}
      {!loading && approvals.length === 0 && (
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
                <div className="text-xs text-slate-500 mt-0.5">Requested by {a.requester_name || 'Unknown'} · needs {a.approver_role} approval</div>
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
              {tab !== 'pending' && a.comments && <span className="text-xs text-slate-500 italic">"{a.comments}"</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
