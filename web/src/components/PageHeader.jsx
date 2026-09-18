export default function PageHeader({ title, description, actions }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/75 px-5 py-4 shadow-card backdrop-blur-xl dark:border-white/[0.07] dark:bg-slate-900/70 sm:px-6">
      <div className="absolute right-0 top-0 h-24 w-40 rounded-full bg-brand-400/10 blur-3xl" />
      <div className="relative flex items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-brand-600 dark:text-brand-400"><span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Workspace</div>
        <h1 className="text-2xl font-display font-bold text-slate-900 dark:text-white tracking-tight">{title}</h1>
        {description && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
