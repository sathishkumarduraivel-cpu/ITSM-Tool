export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="card p-10 text-center text-slate-400 dark:text-slate-500">
      {Icon && <Icon className="mx-auto mb-2 text-slate-300 dark:text-slate-600" size={28} />}
      {title && <div className="font-medium text-slate-500 dark:text-slate-400 mb-0.5">{title}</div>}
      {description && <div className="text-sm">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
