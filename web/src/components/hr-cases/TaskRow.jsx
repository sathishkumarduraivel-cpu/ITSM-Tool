import { useState } from 'react';
import { Trash2, Lock, Check, X, Loader2 } from 'lucide-react';
import { TASK_STATUSES, TASK_STATUS_STYLE } from '../../lib/hrCaseConstants.js';
import Select from '../Select.jsx';

export default function TaskRow({ task, agents, groups, onUpdate, onDelete, onDecide }) {
  const [busy, setBusy] = useState(false);
  const assignee = agents.find((a) => a.id === task.assignee_id);
  const group = groups.find((g) => g.id === task.group_id);
  const isDoneLike = task.status === 'done' || task.status === 'skipped';

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 rounded-lg ${task.blocked ? 'opacity-60' : ''}`}>
      <div className="pt-0.5 shrink-0">
        {task.requires_decision ? (
          task.decision ? (
            <span className={`badge ${task.decision === 'approved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
              {task.decision}
            </span>
          ) : task.blocked ? (
            <span className="text-slate-300 dark:text-slate-600" title="Blocked until its dependency is done"><Lock size={16} /></span>
          ) : (
            <div className="flex items-center gap-1">
              <button disabled={busy} onClick={() => run(() => onDecide(task.id, true))} className="text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 rounded-md p-1" title="Approve">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button disabled={busy} onClick={() => run(() => onDecide(task.id, false))} className="text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md p-1" title="Reject">
                <X size={14} />
              </button>
            </div>
          )
        ) : (
          <Select
            variant="badge"
            className={TASK_STATUS_STYLE[task.status]}
            value={task.status}
            disabled={busy}
            onChange={(v) => run(() => onUpdate(task.id, { status: v }))}
            options={TASK_STATUSES}
            title={task.blocked ? 'Blocked until its dependency is done — you can still change this' : undefined}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium text-slate-800 dark:text-slate-100 ${isDoneLike ? 'line-through text-slate-400 dark:text-slate-500' : ''}`}>
          {task.title}
        </div>
        {task.description && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{task.description}</div>}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          {group && <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{group.name}</span>}
          {assignee && <span className="text-[11px] text-slate-400">→ {assignee.name}</span>}
          {task.due_at && (
            <span className={`text-[11px] font-medium ${task.overdue ? 'text-red-500' : 'text-slate-400'}`}>
              due {new Date(task.due_at).toLocaleDateString()}{task.overdue ? ' — overdue' : ''}
            </span>
          )}
          {task.blocked && !task.requires_decision && <span className="text-[11px] text-slate-400 flex items-center gap-0.5"><Lock size={10} /> blocked</span>}
          {task.source === 'ai' && <span className="text-[11px] text-brand-500">AI-drafted</span>}
        </div>
      </div>

      <button onClick={() => onDelete(task.id)} className="text-slate-300 hover:text-red-500 dark:text-slate-600 shrink-0" title="Remove task">
        <Trash2 size={14} />
      </button>
    </div>
  );
}
