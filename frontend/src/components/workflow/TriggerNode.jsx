import { Handle, Position } from '@xyflow/react';
import { Zap } from 'lucide-react';
import { EVENTS } from '../../lib/workflowConstants.js';

export default function TriggerNode({ data, selected }) {
  const label = EVENTS.find((e) => e.value === data.event)?.label || data.event;
  return (
    <div
      className={`w-56 rounded-2xl border bg-white/95 dark:bg-slate-900/90 backdrop-blur-xl shadow-card dark:shadow-card-dark transition-shadow ${
        selected ? 'border-brand-400 ring-4 ring-brand-500/15' : 'border-white/60 dark:border-white/[0.08]'
      } ${data.highlighted ? 'ring-4 ring-emerald-400/40 border-emerald-400' : ''}`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-t-2xl text-white bg-gradient-to-b from-brand-500 to-brand-700">
        <div className="w-6 h-6 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
          <Zap size={13} />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide opacity-80 leading-none mb-0.5">Trigger</div>
          <div className="text-xs font-semibold truncate leading-none">{label}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!w-4 !h-4 !bg-brand-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform" />
    </div>
  );
}
