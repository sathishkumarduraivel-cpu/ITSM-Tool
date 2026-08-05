import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, Check, X, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { TypeBadge } from '../components/Badge.jsx';

export default function Approvals() {
  const [tab, setTab] = useState('pending');
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [comments, setComments] = useState({});
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    const { approvals } = await api.get(`/approvals?status=${tab}`);
    setApprovals(approvals);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab]);

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
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Approvals</h1>
        <p className="text-sm text-slate-500">Service catalog requests &amp; change advisory board sign-offs</p>
      </div>

      <div className="flex gap-2">
        {['pending', 'approved', 'rejected'].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={t === tab ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}
      {!loading && approvals.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <CheckSquare className="mx-auto mb-2 text-slate-300" size={28} /> Nothing {tab} right now.
        </div>
      )}

      <div className="space-y-2">
        {approvals.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <button onClick={() => navigate(`/tickets/${a.ticket_id}`)} className="font-medium text-slate-800 hover:underline flex items-center gap-2">
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
