import { useState } from 'react';
import { Trash2, Lock, Loader2, ArrowUp, ArrowDown } from 'lucide-react';
import { TICKET_TASK_STATUSES, TICKET_TASK_STATUS_STYLE, TICKET_TASK_PRIORITY_STYLE } from '../../lib/taskConstants.js';
import Select from '../Select.jsx';

export default function TicketTaskRow({ task, canManage, isFirst, isLast, onUpdate, onDelete, onMove }) {
  const [busy, setBusy] = useState(false);
  const isDone = task.status === 'done';

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className={`flex items-start gap-2.5 px-3 py-2.5 ${task.blocked ? 'opacity-70' : ''}`}>
      {canManage && (
        <div className="flex flex-col items-center pt-0.5 shrink-0">
          <button onClick={() => onMove(-1)} disabled={isFirst} className="text-slate-300 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-20"><ArrowUp size={11} /></button>
          <button onClick={() => onMove(1)} disabled={isLast} className="text-slate-300 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-20"><ArrowDown size={11} /></button>
        </div>
      )}

      <div className="pt-0.5 shrink-0">
        {canManage ? (
          <Select
            variant="badge"
            className={TICKET_TASK_STATUS_STYLE[task.status]}
            value={task.status}
            disabled={busy}
            onChange={(v) => run(() => onUpdate(task.id, { status: v }))}
            options={TICKET_TASK_STATUSES}
            title={task.blocked ? `Blocked until "${task.depends_on_title}" is done — you can still change this` : undefined}
          />
        ) : (
          <span className={`badge ${TICKET_TASK_STATUS_STYLE[task.status]}`}>{TICKET_TASK_STATUSES.find((s) => s.value === task.status)?.label}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium text-slate-800 dark:text-slate-100 ${isDone ? 'line-through text-slate-400 dark:text-slate-500' : ''}`}>
          {task.title}
        </div>
        {task.description && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{task.description}</div>}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <span className={`badge ${TICKET_TASK_PRIORITY_STYLE[task.priority]}`}>{task.priority}</span>
          {task.assignee_name && <span className="text-[11px] text-slate-400">→ {task.assignee_name}</span>}
          {task.due_date && (
            <span className={`text-[11px] font-medium ${task.overdue ? 'text-red-500' : 'text-slate-400'}`}>
              due {new Date(task.due_date).toLocaleDateString()}{task.overdue ? ' — overdue' : ''}
            </span>
          )}
          {task.blocked && (
            <span className="text-[11px] text-slate-400 flex items-center gap-0.5"><Lock size={10} /> blocked by "{task.depends_on_title}"</span>
          )}
        </div>
      </div>

      {canManage && (
        <button onClick={() => run(() => onDelete(task.id))} disabled={busy} className="text-slate-300 hover:text-red-500 dark:text-slate-600 shrink-0" title="Remove task">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      )}
    </div>
  );
}
