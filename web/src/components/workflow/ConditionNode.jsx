import { Handle, Position } from '@xyflow/react';
import { GitBranch, AlertTriangle } from 'lucide-react';
import { summarizeCondition } from '../../lib/workflowConstants.js';

export default function ConditionNode({ data, selected }) {
  const hasError = data.errors?.length > 0;
  return (
    <div
      className={`w-60 rounded-2xl border bg-white/95 dark:bg-slate-900/90 backdrop-blur-xl shadow-card dark:shadow-card-dark transition-shadow ${
        selected ? 'border-brand-400 ring-4 ring-brand-500/15' : hasError ? 'border-red-300 dark:border-red-800' : 'border-white/60 dark:border-white/[0.08]'
      } ${data.highlighted ? 'ring-4 ring-emerald-400/40 border-emerald-400' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!w-4 !h-4 !bg-amber-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform" />

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-white/[0.06]">
        <div className="w-6 h-6 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <GitBranch size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none mb-0.5">
            Condition — {data.match === 'any' ? 'any match' : 'all match'}
          </div>
        </div>
        {hasError && <AlertTriangle size={13} className="text-red-500 shrink-0" />}
      </div>

      <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
        {summarizeCondition(data)}
      </div>

      <div className="flex items-center justify-between px-3 pb-2 text-[10px] font-semibold">
        <span className="text-emerald-600 dark:text-emerald-400">Yes ↴</span>
        <span className="text-red-500 dark:text-red-400">No ↴</span>
      </div>

      <Handle
        id="yes"
        type="source"
        position={Position.Bottom}
        style={{ left: '25%' }}
        className="!w-4 !h-4 !bg-emerald-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform"
      />
      <Handle
        id="no"
        type="source"
        position={Position.Bottom}
        style={{ left: '75%' }}
        className="!w-4 !h-4 !bg-red-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform"
      />
    </div>
  );
}
