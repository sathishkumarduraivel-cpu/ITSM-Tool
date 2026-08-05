export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="card p-12 text-center text-slate-400 dark:text-slate-500">
      {Icon && (
        <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <Icon className="text-slate-400 dark:text-slate-500" size={22} />
        </div>
      )}
      {title && <div className="font-display font-semibold text-slate-600 dark:text-slate-300 mb-0.5">{title}</div>}
      {description && <div className="text-sm max-w-sm mx-auto">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
