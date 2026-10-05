import { useEffect, useState } from 'react';
import { Loader2, Bot, FileStack, FilePlus, Sparkles } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import { EMPLOYMENT_TYPES } from '../../lib/hrCaseConstants.js';

const MODES = [
  { key: 'blank', label: 'Start blank', icon: FilePlus, description: 'Add tasks yourself as you go.' },
  { key: 'template', label: 'From a template', icon: FileStack, description: 'Apply a saved department checklist.' },
  { key: 'ai', label: 'Ask Sona', icon: Bot, description: 'Describe the role, get a drafted checklist.' },
];

function resolveGroupId(groups, name) {
  return groups.find((g) => g.name.toLowerCase() === (name || '').toLowerCase())?.id || null;
}

export default function NewHrCaseModal({ caseType, onClose, onCreated }) {
  const [mode, setMode] = useState('blank');
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);

  const [fields, setFields] = useState({
    employee_name: '', employee_email: '', job_title: '', department: '',
    employment_type: 'full_time', location: '', manager_id: '', buddy_id: '',
    start_date: '', last_working_day: '', risk_level: 'standard', notes: '',
  });
  const set = (patch) => setFields((f) => ({ ...f, ...patch }));

  const [aiDescription, setAiDescription] = useState('');
  const [aiDraft, setAiDraft] = useState(null); // { tasks, suggested_risk_level } | null
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/hr-cases/templates').catch(() => ({ templates: [] })),
      api.get('/auth/users').catch(() => ({ users: [] })),
      api.get('/groups').catch(() => ({ groups: [] })),
    ]).then(([t, u, g]) => {
      setTemplates(t.templates.filter((tpl) => tpl.case_type === caseType && tpl.enabled));
      setAgents(u.users.filter((usr) => usr.role === 'agent' || usr.role === 'admin'));
      setGroups(g.groups);
    });
  }, [caseType]);

  const draftWithSona = async () => {
    if (!aiDescription.trim()) return;
    setDrafting(true);
    setError('');
    try {
      const { draft } = await api.post('/hr-cases/draft', {
        case_type: caseType, description: aiDescription.trim(),
        department: fields.department, job_title: fields.job_title, employment_type: fields.employment_type,
      });
      setAiDraft(draft);
      if (caseType === 'offboarding' && draft.suggested_risk_level) set({ risk_level: draft.suggested_risk_level });
    } catch (e) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!fields.employee_name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const payload = { case_type: caseType, ...fields };
      if (mode === 'template' && templateId) payload.template_id = templateId;
      if (mode === 'ai' && aiDraft) {
        payload.tasks = aiDraft.tasks.map(({ group_name, ...t }) => ({ ...t, group_id: resolveGroupId(groups, group_name) }));
        payload.tasks_source = 'ai';
      }
      const { id } = await api.post('/hr-cases', payload);
      onCreated(id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = fields.employee_name.trim() && (mode !== 'ai' || aiDraft) && !saving;

  return (
    <Modal title={`New ${caseType} case`} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Employee name</label>
            <input className="input" required value={fields.employee_name} onChange={(e) => set({ employee_name: e.target.value })} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={fields.employee_email} onChange={(e) => set({ employee_email: e.target.value })} />
          </div>
          <div>
            <label className="label">Job title</label>
            <input className="input" value={fields.job_title} onChange={(e) => set({ job_title: e.target.value })} />
          </div>
          <div>
            <label className="label">Department</label>
            <input className="input" value={fields.department} onChange={(e) => set({ department: e.target.value })} />
          </div>
          <div>
            <label className="label">Employment type</label>
            <Select value={fields.employment_type} onChange={(v) => set({ employment_type: v })} options={EMPLOYMENT_TYPES} />
          </div>
          <div>
            <label className="label">Location</label>
            <input className="input" value={fields.location} onChange={(e) => set({ location: e.target.value })} />
          </div>
          <div>
            <label className="label">{caseType === 'offboarding' ? 'Last working day' : 'Start date'}</label>
            <input
              className="input" type="date"
              value={caseType === 'offboarding' ? fields.last_working_day : fields.start_date}
              onChange={(e) => set(caseType === 'offboarding' ? { last_working_day: e.target.value } : { start_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Manager</label>
            <Select
              placeholder="Select manager…" value={fields.manager_id} onChange={(v) => set({ manager_id: v })}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          </div>
          {caseType === 'onboarding' && (
            <div>
              <label className="label">Buddy (optional)</label>
              <Select
                placeholder="Select buddy…" value={fields.buddy_id} onChange={(v) => set({ buddy_id: v })}
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
            </div>
          )}
          {caseType === 'offboarding' && (
            <div>
              <label className="label">Risk level</label>
              <Select
                value={fields.risk_level} onChange={(v) => set({ risk_level: v })}
                options={[{ value: 'standard', label: 'Standard' }, { value: 'elevated', label: 'Elevated — privileged/admin access' }]}
              />
            </div>
          )}
        </div>

        <div>
          <label className="label mb-1.5">Checklist</label>
          <div className="grid grid-cols-3 gap-2">
            {MODES.map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.key} type="button" onClick={() => setMode(m.key)}
                  className={`text-left rounded-xl border p-2.5 transition-colors ${
                    mode === m.key ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon size={15} className={mode === m.key ? 'text-brand-600 dark:text-brand-400' : 'text-slate-400'} />
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 mt-1">{m.label}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{m.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        {mode === 'template' && (
          <div>
            <label className="label">Template</label>
            <Select
              placeholder="Select a template…" value={templateId} onChange={setTemplateId}
              options={templates.map((t) => ({ value: t.id, label: `${t.name} (${t.tasks.length} tasks)` }))}
            />
            {templates.length === 0 && <p className="text-xs text-slate-400 mt-1">No {caseType} templates yet — set one up in Admin Settings, or start blank / ask Sona.</p>}
          </div>
        )}

        {mode === 'ai' && (
          <div className="space-y-2">
            <textarea
              className="input" rows={2}
              placeholder="e.g. Senior DevOps Engineer joining the Platform team, needs AWS admin and production access."
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
            />
            <button type="button" onClick={draftWithSona} disabled={drafting || !aiDescription.trim()} className="btn-secondary text-xs">
              {drafting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Draft checklist
            </button>
            {aiDraft && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Drafted {aiDraft.tasks.length} tasks. You'll be able to review and edit every one before your team starts.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!canSubmit} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Create case
          </button>
        </div>
      </form>
    </Modal>
  );
}
