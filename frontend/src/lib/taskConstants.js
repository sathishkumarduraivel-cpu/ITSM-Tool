// Shared style/option lists for a ticket's Tasks panel (TicketTaskRow.jsx,
// AddTicketTaskForm.jsx, TicketDetail.jsx) -- mirrors the badge-styled
// Select convention hr-cases/TaskRow.jsx already established for its own
// (differently-shaped) task checklist, so the two "task" concepts in this
// app read as the same interaction language even though they're separate
// features with separate tables.
export const TICKET_TASK_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

export const TICKET_TASK_STATUS_STYLE = {
  open: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

export const TICKET_TASK_PRIORITY_STYLE = {
  low: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  medium: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  high: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
