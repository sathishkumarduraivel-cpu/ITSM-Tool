import { MODES, modeOf } from '../../lib/workflowConstants.js';

export default function ModeControl({ wf, onChange }) {
  const current = modeOf(wf);
  const patchFor = {
    off: { enabled: false, test_mode: false },
    test: { enabled: true, test_mode: true },
    live: { enabled: true, test_mode: false },
  };
  return (
    <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onChange(patchFor[m.key])}
          className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            current === m.key ? m.on : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
          }`}
          title={
            m.key === 'off' ? 'Not evaluated at all' :
            m.key === 'test' ? 'Checks real tickets, only logs what it would do — nothing actually happens' :
            'Fully live — actions run for real'
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
