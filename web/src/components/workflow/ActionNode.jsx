import { Handle, Position } from '@xyflow/react';
import { AlertTriangle } from 'lucide-react';
import { ACTION_ICONS, TIER_STYLE, actionLabel, summarizeAction } from '../../lib/workflowConstants.js';

export default function ActionNode({ data, selected }) {
  const Icon = ACTION_ICONS[data.type];
  const hasError = data.errors?.length > 0;
  const tier = data.riskTier;
  return (
    <div
      className={`w-60 rounded-2xl border bg-white/95 dark:bg-slate-900/90 backdrop-blur-xl shadow-card dark:shadow-card-dark transition-shadow ${
        selected ? 'border-brand-400 ring-4 ring-brand-500/15' : hasError ? 'border-red-300 dark:border-red-800' : 'border-white/60 dark:border-white/[0.08]'
      } ${data.highlighted ? 'ring-4 ring-emerald-400/40 border-emerald-400' : ''} ${data.gated ? 'ring-4 ring-red-400/30 border-red-400' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!w-4 !h-4 !bg-brand-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform" />

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="w-7 h-7 rounded-lg bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
          {Icon && <Icon size={14} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{actionLabel(data.type)}</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{summarizeAction(data, data.agentName)}</div>
        </div>
        {hasError && <AlertTriangle size={13} className="text-red-500 shrink-0" />}
      </div>

      {tier && tier !== 'A' && (
        <div className="px-3 pb-2">
          <span className={`badge ${TIER_STYLE[tier]}`}>Tier {tier}{tier === 'C' ? ' — needs approval' : ''}</span>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!w-4 !h-4 !bg-brand-500 !border-2 !border-white dark:!border-slate-900 hover:!scale-125 transition-transform" />
    </div>
  );
}
