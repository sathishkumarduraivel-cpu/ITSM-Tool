import { AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import Modal from './Modal.jsx';

const LABELS = {
  title: 'Title', description: 'Description', status: 'Status', priority: 'Priority',
  impact: 'Impact', urgency: 'Urgency', category: 'Category', subcategory: 'Subcategory',
  team: 'Group', assignee_id: 'Assignee', resolution_code: 'Resolution code',
  closure_code: 'Closure code', pending_reason: 'Pending reason',
};

const show = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).length > 120 ? `${String(v).slice(0, 120)}…` : String(v);
};

const when = (v) => {
  if (!v) return '';
  const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
};

/**
 * Shown when a save is refused because somebody else got there first.
 *
 * The point is that it is actionable. Being told "this changed, your edit was
 * discarded" is only marginally better than losing the edit silently — what
 * the person needs is to see what the other value is, next to their own, and
 * then decide. So both are shown side by side, and the two ways out are
 * explicit: take theirs, or reload and re-apply yours.
 */
export default function ConflictDialog({ conflict, attempted, onReload, onClose }) {
  if (!conflict) return null;
  const fields = Object.keys(conflict.current_values || {});

  return (
    <Modal title="Somebody else changed this" onClose={onClose} maxWidth="max-w-2xl">
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm dark:bg-amber-500/10">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="text-amber-900 dark:text-amber-200">
              {conflict.updated_by_name
                ? `${conflict.updated_by_name} saved a change while you were editing.`
                : 'This was changed while you were editing.'}
            </p>
            <p className="mt-0.5 text-[11px] text-amber-800/70 dark:text-amber-300/70">
              Nothing you typed has been saved, and nothing of theirs has been lost.
              {conflict.updated_at ? ` Their change: ${when(conflict.updated_at)}.` : ''}
            </p>
          </div>
        </div>

        {!!fields.length && (
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-white/10">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Field</th>
                  <th className="px-3 py-2 text-left font-medium">Now saved</th>
                  <th className="px-3 py-2 text-left font-medium">What you typed</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const theirs = show(conflict.current_values[f]);
                  const yours = show(attempted?.[f]);
                  const same = theirs === yours;
                  return (
                    <tr key={f} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">{LABELS[f] || f.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{theirs}</td>
                      <td className={`px-3 py-2 ${same ? 'text-slate-400' : 'font-medium text-slate-800 dark:text-slate-100'}`}>
                        {same ? 'no change' : yours}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!!conflict.recent_changes?.length && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Recent activity</p>
            <div className="space-y-1">
              {conflict.recent_changes.slice(0, 4).map((h, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <Clock size={10} className="shrink-0" />
                  <span className="font-medium">{String(h.event).replace(/_/g, ' ')}</span>
                  <span className="min-w-0 flex-1 truncate">{h.detail}</span>
                  <span className="shrink-0">{when(h.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Keep editing</button>
          <button onClick={onReload} className="btn-primary">
            <RefreshCw size={14} /> Reload and start from theirs
          </button>
        </div>
      </div>
    </Modal>
  );
}
