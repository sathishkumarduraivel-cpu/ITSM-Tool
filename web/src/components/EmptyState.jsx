export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-white/50 p-10 text-center text-slate-400 shadow-card dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500">
      <div className="absolute left-1/2 top-0 h-24 w-44 -translate-x-1/2 rounded-full bg-brand-400/10 blur-3xl" />
      {Icon && (
        <div className="relative mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 ring-8 ring-brand-50/50 dark:bg-brand-500/10 dark:ring-brand-500/5">
          <Icon className="text-slate-400 dark:text-slate-500" size={22} />
        </div>
      )}
      {title && <div className="relative font-display font-semibold text-slate-700 dark:text-slate-200 mb-1">{title}</div>}
      {description && <div className="relative text-sm max-w-sm mx-auto leading-6">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
