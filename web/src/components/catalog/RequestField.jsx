import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import Select from '../Select.jsx';

// One field on a catalog request form, driven entirely by the item's schema.
//
// The dynamic types (person, team, asset) fetch their own options rather than
// expecting the parent to know what every form on the system might need.
function DynamicPicker({ field, value, onChange, disabled }) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const endpoint = field.type === 'user' ? '/tickets/assignable-agents'
      : field.type === 'group' ? '/groups'
        : '/assets';
    api.get(endpoint)
      .then((d) => {
        if (!live) return;
        const rows = d.agents || d.groups || d.assets || [];
        setOptions(rows.map((r) => ({
          value: r.id,
          label: r.tag ? `${r.name} (${r.tag})` : r.name,
        })));
      })
      .catch(() => { if (live) setOptions([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [field.type]);

  return (
    <Select
      disabled={disabled}
      value={value || ''}
      onChange={(v) => onChange(field.key, v || null)}
      placeholder={loading ? 'Loading…' : 'Not chosen'}
      options={[{ value: '', label: 'Not chosen' }, ...options]}
    />
  );
}

export default function RequestField({ field, value, onChange, error, disabled = false }) {
  const set = (v) => onChange(field.key, v);
  const cls = `input ${error ? 'border-red-400 dark:border-red-500' : ''}`;

  let control;
  switch (field.type) {
    case 'textarea':
      control = <textarea className={cls} rows={3} disabled={disabled} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'number':
      control = (
        <input
          className={cls} type="number" disabled={disabled}
          min={field.min ?? undefined} max={field.max ?? undefined}
          value={value ?? ''} onChange={(e) => set(e.target.value === '' ? null : e.target.value)}
        />
      );
      break;
    case 'checkbox':
      // A real yes/no rather than a bare checkbox: the server distinguishes
      // "no" from "not answered", and a checkbox cannot express that.
      control = (
        <Select
          disabled={disabled}
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          onChange={(v) => set(v === '' ? null : v === 'yes')}
          options={[{ value: '', label: 'Not answered' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
        />
      );
      break;
    case 'select':
      control = (
        <Select
          disabled={disabled} value={value ?? ''} onChange={(v) => set(v || null)}
          options={[{ value: '', label: 'Choose…' }, ...(field.options || []).map((o) => ({ value: o, label: o }))]}
        />
      );
      break;
    case 'multiselect':
      control = (
        <Select
          multiple disabled={disabled}
          value={Array.isArray(value) ? value : []}
          onChange={(v) => set(v)}
          options={(field.options || []).map((o) => ({ value: o, label: o }))}
          placeholder="None chosen"
        />
      );
      break;
    case 'date':
      control = <input className={cls} type="date" disabled={disabled} value={(value ?? '').slice(0, 10)} onChange={(e) => set(e.target.value)} />;
      break;
    case 'email':
      control = <input className={cls} type="email" disabled={disabled} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'user':
    case 'group':
    case 'asset':
      control = <DynamicPicker field={field} value={value} onChange={onChange} disabled={disabled} />;
      break;
    default:
      control = <input className={cls} disabled={disabled} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  }

  return (
    <div>
      <label className="label">
        {field.label}
        {field.required && <span className="text-red-500">*</span>}
      </label>
      {control}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!error && field.help_text && (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-slate-400">
          <Info size={11} className="mt-0.5 shrink-0" /> {field.help_text}
        </p>
      )}
    </div>
  );
}

/**
 * Which fields are on screen, given the answers so far.
 *
 * A deliberate mirror of visibleFields() on the server. The server is the one
 * that decides -- it discards values for hidden fields rather than trusting
 * them -- but the form has to agree, or a requester sees a question the
 * server is about to throw away.
 */
export function visibleFields(schema, values) {
  const fields = Array.isArray(schema) ? schema : [];
  let visible = fields;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = fields.filter((f) => {
      if (!f.show_when?.field) return true;
      const controller = fields.find((c) => c.key === f.show_when.field);
      if (controller && !visible.includes(controller)) return false;
      return evaluate(f.show_when, values);
    });
    if (next.length === visible.length && next.every((f, i) => f === visible[i])) return next;
    visible = next;
  }
  return visible;
}

function evaluate({ field, op = 'equals', value }, values) {
  const actual = values?.[field];
  const empty = actual === undefined || actual === null || actual === ''
    || (Array.isArray(actual) && actual.length === 0);
  switch (op) {
    case 'is_empty': return empty;
    case 'is_not_empty': return !empty;
    case 'not_equals': return String(actual ?? '') !== String(value ?? '');
    case 'gt': return Number(actual) > Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'contains':
      return Array.isArray(actual)
        ? actual.map(String).includes(String(value))
        : String(actual ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    default: return String(actual ?? '') === String(value ?? '');
  }
}
