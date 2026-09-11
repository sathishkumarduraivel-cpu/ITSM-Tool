import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import Select from '../Select.jsx';

export default function AddTicketTaskForm({ agents, existingTasks, onAdd, onClose }) {
  const [form, setForm] = useState({ title: '', assignee_id: '', priority: 'medium', due_date: '', depends_on_task_id: '' });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await onAdd({ ...form, assignee_id: form.assignee_id || null, due_date: form.due_date || null, depends_on_task_id: form.depends_on_task_id || null });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="card-flat p-3 space-y-2">
      <div className="flex gap-2">
        <input className="input flex-1" autoFocus placeholder="Task title" value={form.title} onChange={(e) => set({ title: e.target.value })} />
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Select value={form.assignee_id} onChange={(v) => set({ assignee_id: v })} placeholder="Unassigned" options={[{ value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
        <Select value={form.priority} onChange={(v) => set({ priority: v })} options={['low', 'medium', 'high']} />
        <input className="input" type="date" value={form.due_date} onChange={(e) => set({ due_date: e.target.value })} />
        <Select
          value={form.depends_on_task_id} onChange={(v) => set({ depends_on_task_id: v })} placeholder="No dependency"
          options={[{ value: '', label: 'No dependency' }, ...existingTasks.map((t) => ({ value: t.id, label: t.title }))]}
        />
      </div>
      <div className="flex justify-end">
        <button type="submit" disabled={saving || !form.title.trim()} className="btn-primary text-xs">
          {saving ? <Loader2 size={13} className="animate-spin" /> : null} Add task
        </button>
      </div>
    </form>
  );
}
