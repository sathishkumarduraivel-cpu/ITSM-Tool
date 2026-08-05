const TONES = {
  brand: 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400',
  red: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
};

export default function StatCard({ icon: Icon, label, value, tone = 'brand' }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${TONES[tone]}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-semibold text-slate-800 dark:text-slate-100 leading-none">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">{label}</div>
      </div>
    </div>
  );
}
