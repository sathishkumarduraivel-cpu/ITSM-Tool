const TONES = {
  brand: 'from-brand-500/15 to-brand-500/5 text-brand-600 dark:text-brand-400',
  red: 'from-red-500/15 to-red-500/5 text-red-600 dark:text-red-400',
  amber: 'from-amber-500/15 to-amber-500/5 text-amber-600 dark:text-amber-400',
  green: 'from-emerald-500/15 to-emerald-500/5 text-emerald-600 dark:text-emerald-400',
};

export default function StatCard({ icon: Icon, label, value, tone = 'brand' }) {
  return (
    <div className="card p-4 flex items-center gap-3 hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200">
      <div className={`w-11 h-11 rounded-xl bg-gradient-to-br flex items-center justify-center shrink-0 ${TONES[tone]}`}>
        <Icon size={19} />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100 leading-none tabular-nums">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 truncate">{label}</div>
      </div>
    </div>
  );
}
