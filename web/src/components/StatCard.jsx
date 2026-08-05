const TONES = {
  brand: 'from-brand-400 to-brand-600 text-white',
  red: 'from-red-400 to-red-600 text-white',
  amber: 'from-amber-400 to-amber-600 text-white',
  green: 'from-emerald-400 to-emerald-600 text-white',
};

export default function StatCard({ icon: Icon, label, value, tone = 'brand' }) {
  return (
    <div className="card-interactive p-4 flex items-center gap-3">
      <div className={`icon-tile w-11 h-11 rounded-xl bg-gradient-to-b shrink-0 ${TONES[tone]}`}>
        <Icon size={19} />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100 leading-none tabular-nums">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 truncate">{label}</div>
      </div>
    </div>
  );
}
