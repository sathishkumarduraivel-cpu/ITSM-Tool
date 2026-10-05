import { Laptop, UsersRound, Building2, UserCheck, ShieldCheck, CircleDot } from 'lucide-react';

export const CASE_TYPES = [
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'offboarding', label: 'Offboarding' },
];

export const EMPLOYMENT_TYPES = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'intern', label: 'Intern' },
];

export const TRACKS = [
  { value: 'it', label: 'IT', icon: Laptop },
  { value: 'hr', label: 'HR', icon: UsersRound },
  { value: 'facilities', label: 'Facilities', icon: Building2 },
  { value: 'manager', label: 'Manager', icon: UserCheck },
  { value: 'approval', label: 'Approval', icon: ShieldCheck },
  { value: 'other', label: 'Other', icon: CircleDot },
];

export function trackMeta(track) {
  return TRACKS.find((t) => t.value === track) || TRACKS[TRACKS.length - 1];
}

export const TASK_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'skipped', label: 'Skipped' },
];

export const TASK_STATUS_STYLE = {
  pending: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  skipped: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 line-through',
};

export const CASE_STATUS_STYLE = {
  in_progress: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  cancelled: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

export const RISK_STYLE = {
  standard: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  elevated: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
