import { X, Trash2, Plus } from 'lucide-react';
import { EVENTS, FIELDS, FIELD_LABELS, OPS, FIELD_ENUMS, ACTION_TYPES, TIER_STYLE, APPROVER_ROLES } from '../../lib/workflowConstants.js';
import Select from '../Select.jsx';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function ConditionValueInput({ field, value, onChange, groups }) {
  if (FIELD_ENUMS[field]) {
    return <Select placeholder="Select value…" value={value} onChange={onChange} options={FIELD_ENUMS[field]} />;
  }
  if (field === 'team' && groups.length > 0) {
    return <Select placeholder="Select group…" value={value} onChange={onChange} options={groups.map((g) => ({ value: g.name, label: g.name }))} />;
  }
  return <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="value" />;
}

function TriggerInspector({ data, onChange }) {
  return (
    <div>
      <label className="label">Trigger event</label>
      <Select value={data.event} onChange={(v) => onChange({ event: v })} options={EVENTS} />
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">Every workflow needs exactly one trigger — this is where the run starts.</p>
    </div>
  );
}

function ConditionInspector({ data, onChange, groups }) {
  const rules = data.rules || [];
  const setRules = (next) => onChange({ rules: next });
  const addRule = () => setRules([...rules, { field: 'priority', op: 'equals', value: '' }]);
  const updateRule = (i, patch) => setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRule = (i) => setRules(rules.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Match</label>
        <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden w-fit">
          {[{ key: 'all', label: 'ALL rules (AND)' }, { key: 'any', label: 'ANY rule (OR)' }].map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onChange({ match: m.key })}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                (data.match || 'all') === m.key ? 'bg-brand-500 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="label mb-0">Rules</label>
          <button type="button" onClick={addRule} className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
            <Plus size={12} /> Add rule
          </button>
        </div>
        <div className="space-y-2">
          {rules.length === 0 && <p className="text-xs text-slate-400">No rules yet — add at least one.</p>}
          {rules.map((r, i) => (
            <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1.5">
              <div className="flex gap-1.5">
                <Select value={r.field} onChange={(v) => updateRule(i, { field: v })} options={FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] || f }))} />
                <button type="button" onClick={() => removeRule(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
              </div>
              <Select value={r.op} onChange={(v) => updateRule(i, { op: v })} options={OPS} />
              <ConditionValueInput field={r.field} value={r.value} onChange={(v) => updateRule(i, { value: v })} groups={groups} />
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">Wire the <span className="text-emerald-600 dark:text-emerald-400 font-medium">Yes</span> and <span className="text-red-500 dark:text-red-400 font-medium">No</span> handles on the canvas to different actions to branch.</p>
    </div>
  );
}

function ApiCallHeaders({ headers, onChange }) {
  const list = headers || [];
  const update = (i, patch) => onChange(list.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const add = () => onChange([...list, { key: '', value: '' }]);
  const remove = (i) => onChange(list.filter((_, idx) => idx !== i));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="label mb-0">Headers</label>
        <button type="button" onClick={add} className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
          <Plus size={12} /> Add header
        </button>
      </div>
      {list.length === 0 && <p className="text-xs text-slate-400">No custom headers.</p>}
      {list.map((h, i) => (
        <div key={i} className="flex gap-1.5">
          <input className="input" placeholder="Header name" value={h.key} onChange={(e) => update(i, { key: e.target.value })} />
          <input className="input" placeholder="Value" value={h.value} onChange={(e) => update(i, { value: e.target.value })} />
          <button type="button" onClick={() => remove(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
        </div>
      ))}
    </div>
  );
}

function ActionInspector({ data, onChange, agents, integrations, groups, riskTiers }) {
  const set = (patch, replace) => onChange(patch, replace);
  const risk = riskTiers?.[data.type];
  return (
    <div className="space-y-3">
      <div>
        <label className="label">Action type</label>
        <Select value={data.type} onChange={(v) => onChange({ type: v }, true)} options={ACTION_TYPES} />
      </div>

      {risk && (
        <div className={`badge ${TIER_STYLE[risk.tier]}`} title={risk.reason}>Tier {risk.tier}</div>
      )}
      {risk?.tier === 'C' && (
        <p className="text-xs text-red-600 dark:text-red-400">This action needs a human decision every time it fires — its branch pauses for approval, even in Live mode.</p>
      )}

      {data.type === 'set_priority' && (
        <Select placeholder="Select priority…" value={data.priority || ''} onChange={(v) => set({ priority: v })} options={['low', 'medium', 'high', 'critical']} />
      )}
      {data.type === 'set_status' && (
        <Select placeholder="Select status…" value={data.status || ''} onChange={(v) => set({ status: v })} options={['open', 'in_progress', 'on_hold', 'resolved', 'closed']} />
      )}
      {data.type === 'assign_team' && (
        <Select placeholder="Select group…" value={data.team || ''} onChange={(v) => set({ team: v })} options={groups.map((g) => ({ value: g.name, label: g.name }))} />
      )}
      {data.type === 'assign_agent' && (
        <Select placeholder="Select agent…" value={data.agent_id || ''} onChange={(v) => set({ agent_id: v })} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
      )}
      {data.type === 'tag_category' && (
        <div className="space-y-2">
          <input className="input" placeholder="Category" value={data.category || ''} onChange={(e) => set({ category: e.target.value })} />
          <input className="input" placeholder="Subcategory (optional)" value={data.subcategory || ''} onChange={(e) => set({ subcategory: e.target.value })} />
        </div>
      )}
      {data.type === 'add_comment' && (
        <textarea className="input" rows={3} placeholder="Comment body" value={data.body || ''} onChange={(e) => set({ body: e.target.value })} />
      )}
      {data.type === 'create_task' && (
        <div className="space-y-2">
          <input className="input" placeholder="Task title" value={data.title || ''} onChange={(e) => set({ title: e.target.value })} />
          <textarea className="input" rows={2} placeholder="Description (optional)" value={data.description || ''} onChange={(e) => set({ description: e.target.value })} />
          <div className="flex gap-1.5">
            <Select className="flex-1" placeholder="Unassigned" value={data.assignee_id || ''} onChange={(v) => set({ assignee_id: v })} options={[{ value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
            <Select className="w-28 shrink-0" value={data.priority || 'medium'} onChange={(v) => set({ priority: v })} options={['low', 'medium', 'high']} />
          </div>
          <div>
            <label className="label">Due — days after this task is created</label>
            <input type="number" min="0" className="input" placeholder="e.g. 2" value={data.due_in_days ?? ''} onChange={(e) => set({ due_in_days: e.target.value })} />
          </div>
          <p className="text-[11px] text-slate-400">
            Use <code className="text-slate-500">{'{{ticket.field}}'}</code> in the title or description, e.g. <code className="text-slate-500">{'{{ticket.number}}'}</code>.
          </p>
        </div>
      )}
      {data.type === 'notify_integration' && (
        <div className="space-y-2">
          <Select
            placeholder="Any enabled integration of type…" value={data.integration_id || ''} onChange={(v) => set({ integration_id: v })}
            options={integrations.map((i) => ({ value: i.id, label: `${i.name} (${i.type})` }))}
          />
          <input className="input" placeholder="Message" value={data.message || ''} onChange={(e) => set({ message: e.target.value })} />
        </div>
      )}
      {data.type === 'api_call' && (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <Select className="w-24 shrink-0" value={data.method || 'GET'} onChange={(v) => set({ method: v })} options={HTTP_METHODS} />
            <input
              className="input flex-1" placeholder="https://example.com/api/tickets/{{ticket.number}}"
              value={data.url || ''} onChange={(e) => set({ url: e.target.value })}
            />
          </div>
          <p className="text-[11px] text-slate-400">Use <code className="text-slate-500">{'{{ticket.field}}'}</code> anywhere in the URL, headers, or body — e.g. <code className="text-slate-500">{'{{ticket.number}}'}</code>, <code className="text-slate-500">{'{{ticket.priority}}'}</code>.</p>

          <ApiCallHeaders headers={data.headers} onChange={(headers) => set({ headers })} />

          {['POST', 'PUT', 'PATCH'].includes((data.method || 'GET').toUpperCase()) && (
            <div>
              <label className="label">Request body (JSON)</label>
              <textarea className="input font-mono text-xs" rows={3} placeholder={'{\n  "ticket": "{{ticket.number}}"\n}'} value={data.body || ''} onChange={(e) => set({ body: e.target.value })} />
            </div>
          )}

          <div>
            <label className="label">Authentication</label>
            <Select
              value={data.integration_id || ''} onChange={(v) => set({ integration_id: v })}
              options={[
                { value: '', label: 'No authentication' },
                ...integrations.filter((i) => i.type === 'http_api').map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
            {integrations.filter((i) => i.type === 'http_api').length === 0 && (
              <p className="text-xs text-slate-400 mt-1">No API credentials saved yet — add one under Configuration → Integrations (type "API credential") if this endpoint needs a token.</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={!!data.continue_on_error} onChange={(e) => set({ continue_on_error: e.target.checked })} />
            Continue the workflow even if this call fails
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={!!data.save_response_as_comment} onChange={(e) => set({ save_response_as_comment: e.target.checked })} />
            Save the response as a private comment
          </label>
        </div>
      )}
      {(data.type === 'ai_categorize' || data.type === 'ai_suggest_resolution') && (
        <p className="text-xs text-slate-500">Uses your default AI provider (configure under AI Settings).</p>
      )}
      {data.type === 'auto_approve' && (
        <p className="text-xs text-slate-500">Automatically approves any pending approval steps on the triggering ticket, skipping manual review.</p>
      )}
    </div>
  );
}

function ApprovalInspector({ data, onChange, agents }) {
  const set = (patch) => onChange(patch);
  const approverType = data.approver_type || 'role';
  return (
    <div className="space-y-3">
      <div>
        <label className="label">Title</label>
        <input className="input" placeholder="e.g. Sign off before closing" value={data.title || ''} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div>
        <label className="label">Message to the approver (optional)</label>
        <textarea className="input" rows={2} placeholder="Any context they'll need to decide" value={data.message || ''} onChange={(e) => set({ message: e.target.value })} />
      </div>

      <div>
        <label className="label">Who approves</label>
        <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden w-fit mb-2">
          {[{ key: 'role', label: 'Anyone with a role' }, { key: 'user', label: 'A specific person' }].map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => set({ approver_type: m.key })}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                approverType === m.key ? 'bg-brand-500 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {approverType === 'user' ? (
          <Select placeholder="Select person…" value={data.approver_id || ''} onChange={(v) => set({ approver_id: v, approverName: agents.find((a) => a.id === v)?.name })} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        ) : (
          <Select value={data.approver_role || 'admin'} onChange={(v) => set({ approver_role: v })} options={APPROVER_ROLES} />
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Every run pauses here and notifies the approver — nothing downstream runs until they decide. Wire the{' '}
        <span className="text-emerald-600 dark:text-emerald-400 font-medium">Approved</span> and{' '}
        <span className="text-red-500 dark:text-red-400 font-medium">Rejected</span> handles to different next steps to branch on the outcome.
      </p>
    </div>
  );
}

export default function Inspector({ node, onChange, onDelete, onClose, agents, integrations, groups, riskTiers }) {
  if (!node) return null;
  const patch = (dataPatch, replace) => onChange(node.id, dataPatch, replace);

  const titleFor = { trigger: 'Trigger', condition: 'Condition', action: 'Action', approval: 'Approval' };

  return (
    <div className="w-80 shrink-0 card p-4 space-y-3 h-full overflow-y-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-display font-semibold text-slate-800 dark:text-slate-100">{titleFor[node.type] || 'Node'}</h3>
        <div className="flex items-center gap-1">
          {node.type !== 'trigger' && (
            <button onClick={() => onDelete(node.id)} className="text-slate-400 hover:text-red-500 p-1" title="Delete node"><Trash2 size={15} /></button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1"><X size={16} /></button>
        </div>
      </div>

      {node.data?.errors?.length > 0 && (
        <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg px-2.5 py-1.5 space-y-0.5">
          {node.data.errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {node.type === 'trigger' && <TriggerInspector data={node.data} onChange={patch} />}
      {node.type === 'condition' && <ConditionInspector data={node.data} onChange={patch} groups={groups} />}
      {node.type === 'action' && (
        <ActionInspector data={node.data} onChange={patch} agents={agents} integrations={integrations} groups={groups} riskTiers={riskTiers} />
      )}
      {node.type === 'approval' && <ApprovalInspector data={node.data} onChange={patch} agents={agents} />}
    </div>
  );
}
