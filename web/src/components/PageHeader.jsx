export default function PageHeader({ title, description, actions }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100 tracking-tight">{title}</h1>
        {description && <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
