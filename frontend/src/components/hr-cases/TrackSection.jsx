import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { trackMeta } from '../../lib/hrCaseConstants.js';
import TaskRow from './TaskRow.jsx';

export default function TrackSection({ track, tasks, agents, groups, onUpdate, onDelete, onDecide }) {
  const [open, setOpen] = useState(true);
  const meta = trackMeta(track);
  const Icon = meta.icon;
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;

  return (
    <div className="card-flat overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
            <Icon size={13} />
          </div>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{meta.label}</span>
          <span className="text-xs text-slate-400">{done}/{tasks.length}</span>
        </div>
        {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
      </button>
      {open && (
        <div className="divide-y divide-slate-100 dark:divide-white/[0.06] border-t border-slate-100 dark:border-white/[0.06]">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} agents={agents} groups={groups} onUpdate={onUpdate} onDelete={onDelete} onDecide={onDecide} />
          ))}
        </div>
      )}
    </div>
  );
}
