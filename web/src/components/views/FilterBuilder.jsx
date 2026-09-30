import { Plus, Trash2, CornerDownRight } from 'lucide-react';
import Select from '../Select.jsx';

const NO_VALUE = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false', 'is_me', 'is_not_me']);
const MULTI = new Set(['in', 'not_in']);

const blankRule = (fields) => ({ field: fields[0]?.key || 'status', op: 'equals', value: '' });

/**
 * The AND/OR condition builder (§21).
 *
 * Groups nest, so "open AND (high OR critical)" is expressible — which is the
 * whole reason a builder exists rather than a row of dropdowns. The field and
 * operator lists come from the server, so the builder can never offer a
 * combination the server would then refuse.
 */
export default function FilterBuilder({ value, onChange, meta, depth = 0 }) {
  const group = value || { logic: 'AND', rules: [] };
  const fields = meta?.fields || [];
  const fieldMeta = (key) => fields.find((f) => f.key === key);

  const update = (patch) => onChange({ ...group, ...patch });
  const setRule = (i, next) => update({ rules: group.rules.map((r, idx) => (idx === i ? next : r)) });
  const removeRule = (i) => update({ rules: group.rules.filter((_, idx) => idx !== i) });

  return (
    <div className={depth ? 'rounded-xl border border-slate-200 p-2.5 dark:border-white/10' : ''}>
      <div className="mb-2 flex items-center gap-2">
        {/* One toggle per group, so the reading is unambiguous: every rule in
            this group is joined the same way. */}
        <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-white/10">
          {['AND', 'OR'].map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => update({ logic: l })}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                (group.logic || 'AND') === l
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
              }`}
            >{l}</button>
          ))}
        </div>
        <span className="text-[11px] text-slate-400">
          {(group.logic || 'AND') === 'AND' ? 'match every condition' : 'match any condition'}
        </span>
      </div>

      <div className="space-y-1.5">
        {group.rules.map((rule, i) => {
          // A nested object carrying its own rules is a group.
          if (Array.isArray(rule?.rules)) {
            return (
              <div key={i} className="flex items-start gap-1.5">
                <CornerDownRight size={13} className="mt-3 shrink-0 text-slate-300" />
                <div className="min-w-0 flex-1">
                  <FilterBuilder value={rule} onChange={(next) => setRule(i, next)} meta={meta} depth={depth + 1} />
                </div>
                <button type="button" onClick={() => removeRule(i)} className="mt-2.5 shrink-0 text-slate-400 hover:text-red-500">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          }

          const fm = fieldMeta(rule.field);
          const ops = fm?.operators || [];
          const needsValue = !NO_VALUE.has(rule.op);
          const isMulti = MULTI.has(rule.op);

          return (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <div className="min-w-[150px] flex-1">
                <Select
                  value={rule.field}
                  onChange={(v) => {
                    // Changing the field can invalidate the operator, so it
                    // falls back to one the new field actually supports.
                    const next = fieldMeta(v);
                    const op = next?.operators?.includes(rule.op) ? rule.op : next?.operators?.[0];
                    setRule(i, { ...rule, field: v, op, value: '' });
                  }}
                  options={fields.map((f) => ({ value: f.key, label: f.label }))}
                  size="sm"
                  searchable
                />
              </div>
              <div className="min-w-[130px]">
                <Select
                  value={rule.op}
                  onChange={(v) => setRule(i, { ...rule, op: v, value: NO_VALUE.has(v) ? '' : rule.value })}
                  options={ops.map((o) => ({ value: o, label: meta.operators?.[o] || o }))}
                  size="sm"
                />
              </div>
              {needsValue && (
                <input
                  className="input min-w-[130px] flex-1 text-xs"
                  value={Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value ?? '')}
                  onChange={(e) => setRule(i, {
                    ...rule,
                    value: isMulti ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value,
                  })}
                  placeholder={isMulti ? 'comma separated' : (fm?.type === 'date' ? 'YYYY-MM-DD' : 'value')}
                />
              )}
              <button type="button" onClick={() => removeRule(i)} className="shrink-0 text-slate-400 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => update({ rules: [...group.rules, blankRule(fields)] })}
          className="btn-secondary text-xs"
        ><Plus size={12} /> Condition</button>
        {depth < (meta?.limits?.max_depth ?? 5) - 1 && (
          <button
            type="button"
            onClick={() => update({ rules: [...group.rules, { logic: group.logic === 'AND' ? 'OR' : 'AND', rules: [blankRule(fields)] }] })}
            className="btn-secondary text-xs"
          ><Plus size={12} /> Group</button>
        )}
      </div>
    </div>
  );
}
