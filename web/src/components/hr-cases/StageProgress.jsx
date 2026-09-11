import { Check } from 'lucide-react';

// A horizontal stepper across every stage for this case's type. Purely
// display -- the case's stage is derived server-side (hrCaseEngine.js
// recomputeCaseStage) from its tasks, never set here, so this always shows
// real progress rather than a manually-advanced status.
export default function StageProgress({ stages, currentStage }) {
  const currentIdx = stages.findIndex((s) => s.key === currentStage);
  return (
    <div className="flex items-center w-full">
      {stages.map((s, i) => {
        const isDone = i < currentIdx || (currentStage === 'complete' && s.key === 'complete');
        const isCurrent = s.key === currentStage && !isDone;
        return (
          <div key={s.key} className={`flex items-center ${i < stages.length - 1 ? 'flex-1' : ''}`}>
            <div className="flex flex-col items-center gap-1 shrink-0">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-colors ${
                  isDone
                    ? 'bg-emerald-500 text-white'
                    : isCurrent
                    ? 'bg-brand-500 text-white shadow-glow-brand'
                    : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                }`}
              >
                {isDone ? <Check size={13} /> : i + 1}
              </div>
              <span className={`text-[11px] font-medium whitespace-nowrap ${isCurrent ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}`}>
                {s.label}
              </span>
            </div>
            {i < stages.length - 1 && (
              <div className={`h-0.5 flex-1 mx-1.5 rounded-full transition-colors ${isDone ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
