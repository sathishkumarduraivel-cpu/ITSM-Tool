import { useEffect, useState } from 'react';
import {
  Loader2, X, ThumbsUp, ThumbsDown, Pencil, History, Clock, Eye, Ticket as TicketIcon,
  AlertTriangle, CheckCircle2, RotateCcw, Link2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/dates.js';
import { Markdown } from './markdown.jsx';

const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_review: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  published: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  retired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};
const VIS_STYLE = {
  portal: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  agents: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  internal: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

// Read an article, and say whether it helped.
//
// The feedback prompt is the point of this screen as much as the text is. An
// article nobody rates is an article nobody can improve, and the "not
// helpful" path asks why -- a thumbs-down with no reason tells an author
// their work is wrong but not what to change.
export default function ArticleView({ articleId, canManage, onClose, onEdit, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [askWhy, setAskWhy] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState([]);
  const navigate = useNavigate();

  const load = async () => {
    setError('');
    try { setData(await api.get(`/kb/${articleId}`)); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [articleId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const vote = async (helpful) => {
    if (!helpful && !askWhy) { setAskWhy(true); return; }
    try {
      await api.post(`/kb/${articleId}/feedback`, { helpful, comment: comment || null });
      setAskWhy(false); setComment('');
      await load(); onChanged?.();
    } catch (e) { setError(e.message); }
  };

  const move = async (to) => {
    try { await api.post(`/kb/${articleId}/transition`, { to }); await load(); onChanged?.(); }
    catch (e) { setError(e.message); }
  };

  const openVersions = async () => {
    setShowVersions((v) => !v);
    if (!versions.length) {
      try { setVersions((await api.get(`/kb/${articleId}/versions`)).versions); } catch { /* staff-only */ }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 px-4 py-8 dark:bg-slate-950/60" onClick={onClose}>
      <div className="card my-auto w-full max-w-3xl p-5" onClick={(e) => e.stopPropagation()}>
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {!data ? (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </p>
        ) : (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-xl font-semibold text-slate-800 dark:text-slate-100">{data.article.title}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className={`badge ${STATUS_STYLE[data.article.status]}`}>{data.article.status_meta?.label}</span>
                  <span className={`badge ${VIS_STYLE[data.article.visibility]}`}>{data.article.visibility_meta?.label}</span>
                  {data.article.type_meta && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{data.article.type_meta.label}</span>
                  )}
                  {data.article.category && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{data.article.category.name}</span>
                  )}
                  {/* Stale is shown to the reader, not just to the editor:
                      if nobody has checked this in a year, they deserve to
                      know before they follow it. */}
                  {data.article.is_stale && (
                    <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                      <Clock size={9} /> Due a review
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canManage && (
                  <>
                    <button onClick={openVersions} className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600" title="Version history">
                      <History size={15} />
                    </button>
                    <button onClick={() => onEdit(data.article)} className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600" title="Edit">
                      <Pencil size={15} />
                    </button>
                  </>
                )}
                <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600"><X size={17} /></button>
              </div>
            </div>

            {data.article.summary && (
              <p className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                {data.article.summary}
              </p>
            )}

            {canManage && data.transitions?.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {data.transitions.map((t) => (
                  <button key={t.to} onClick={() => move(t.to)} disabled={!t.allowed}
                    title={t.blocker || t.description}
                    className="btn-secondary text-xs disabled:opacity-40">
                    {t.label}
                  </button>
                ))}
                {data.article.is_stale && (
                  <button onClick={async () => { await api.post(`/kb/${articleId}/reviewed`); await load(); onChanged?.(); }}
                    className="btn-secondary text-xs" title="Confirm it is still correct without editing it">
                    <CheckCircle2 size={12} /> Still correct
                  </button>
                )}
              </div>
            )}

            {showVersions && (
              <div className="mb-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Version history</div>
                {versions.length === 0 && <p className="text-xs text-slate-400">No published versions yet.</p>}
                <div className="space-y-1">
                  {versions.map((v) => (
                    <div key={v.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
                      <span className="text-slate-700 dark:text-slate-200">
                        v{v.version} · {v.author_name || 'unknown'} · {fmtDateTime(v.created_at)}
                      </span>
                      <button
                        onClick={async () => {
                          if (!confirm(`Restore version ${v.version}? It comes back as a draft for you to review.`)) return;
                          await api.post(`/kb/${articleId}/versions/${v.version}/restore`);
                          await load(); onChanged?.();
                        }}
                        className="btn-ghost text-[11px]"><RotateCcw size={11} /> Restore</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Markdown text={data.article.body} className="prose-sm max-w-none" />

            {data.article.tag_list?.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {data.article.tag_list.map((t) => (
                  <span key={t} className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">#{t}</span>
                ))}
              </div>
            )}

            {/* Feedback */}
            <div className="mt-5 rounded-xl border border-slate-200 p-3 dark:border-white/10">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-600 dark:text-slate-300">Did this help?</span>
                <button onClick={() => vote(true)}
                  className={`btn-secondary text-xs ${data.my_feedback?.helpful === 1 ? 'border-emerald-400 text-emerald-700 dark:text-emerald-300' : ''}`}>
                  <ThumbsUp size={12} /> Yes
                </button>
                <button onClick={() => vote(false)}
                  className={`btn-secondary text-xs ${data.my_feedback?.helpful === 0 ? 'border-red-400 text-red-700 dark:text-red-300' : ''}`}>
                  <ThumbsDown size={12} /> No
                </button>
                <span className="ml-auto text-[11px] text-slate-400">
                  {data.article.helpful_count || 0} found this helpful
                  {data.article.not_helpful_count ? ` · ${data.article.not_helpful_count} did not` : ''}
                </span>
              </div>
              {askWhy && (
                <div className="mt-2 flex gap-2">
                  <input className="input flex-1 text-sm" autoFocus placeholder="What was missing or wrong?"
                    value={comment} onChange={(e) => setComment(e.target.value)} />
                  <button onClick={() => vote(false)} className="btn-primary shrink-0 text-xs">Send</button>
                </div>
              )}
            </div>

            {data.related?.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Related</h4>
                <div className="space-y-1">
                  {data.related.map((r) => (
                    <button key={r.id} onClick={() => onChanged?.(r.id)}
                      className="w-full rounded-md bg-slate-50 px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800">
                      {r.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {data.article.linked_tickets?.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
                  <TicketIcon size={12} /> Tickets
                </h4>
                <div className="space-y-1">
                  {data.article.linked_tickets.map((t) => (
                    <button key={`${t.id}-${t.relation}`} onClick={() => navigate(`/tickets/${t.id}`)}
                      className="w-full rounded-md bg-slate-50 px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:bg-slate-800/60">
                      <span className="text-slate-700 dark:text-slate-200">{t.number} — {t.title}</span>
                      <span className="ml-1.5 text-slate-400">({t.relation.replace('_', ' ')})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {canManage && data.stats && (
              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-center dark:border-slate-800 sm:grid-cols-4">
                <Stat icon={Eye} label="Views" value={data.stats.lifetime_views} />
                <Stat icon={ThumbsUp} label="Helpful" value={`${data.stats.helpful_rate ?? '—'}${data.stats.helpful_rate != null ? '%' : ''}`} />
                <Stat icon={TicketIcon} label="Resolved with" value={data.stats.resolved_tickets} />
                <Stat icon={Clock} label="Updated" value={fmtRelative(data.article.updated_at)} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        <Icon size={10} /> {label}
      </div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</div>
    </div>
  );
}
