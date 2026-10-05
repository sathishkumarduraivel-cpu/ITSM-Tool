import { useEffect, useState } from 'react';
import { Link2, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import Select from '../Select.jsx';

// Renders one CI attribute from its server-declared schema.
//
// Every form in this module is built from whatever `effectiveAttributes`
// returns, so an admin adding a field in CMDB Configuration gets a working,
// validated input everywhere without a line of UI being written for it. That
// is the whole point of the class model, and it only holds if the renderer
// covers every data type the server will accept.

// A reference field needs to offer real CIs of the referenced class, so it
// fetches them rather than expecting the parent to know.
function ReferencePicker({ attr, value, onChange, disabled }) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get(`/assets?class_id=${attr.reference_class_id}`)
      .then((d) => { if (live) setOptions(d.assets || []); })
      .catch(() => { if (live) setOptions([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [attr.reference_class_id]);

  return (
    <Select
      disabled={disabled}
      value={value || ''}
      onChange={onChange}
      placeholder={loading ? 'Loading…' : 'Not linked'}
      options={[
        { value: '', label: 'Not linked' },
        ...options.map((o) => ({ value: o.id, label: `${o.name} (${o.tag})` })),
      ]}
    />
  );
}

export default function AttributeField({ attr, value, onChange, error, disabled = false }) {
  const common = { disabled, className: `input ${error ? 'border-red-400 dark:border-red-500' : ''}` };
  const set = (v) => onChange(attr.attr_key, v);

  let control;
  switch (attr.data_type) {
    case 'textarea':
      control = <textarea {...common} rows={3} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'boolean':
      // A tri-state, not a checkbox: "nobody has said" is genuinely different
      // from "no", and a checkbox cannot express the difference.
      control = (
        <Select
          disabled={disabled}
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          onChange={(v) => set(v === '' ? null : v === 'yes')}
          options={[{ value: '', label: 'Not set' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
        />
      );
      break;
    case 'select':
      control = (
        <Select
          disabled={disabled}
          value={value ?? ''}
          onChange={(v) => set(v || null)}
          options={[{ value: '', label: 'Not set' }, ...(attr.options || []).map((o) => ({ value: o, label: o }))]}
        />
      );
      break;
    case 'multiselect':
      control = (
        <Select
          multiple
          disabled={disabled}
          value={Array.isArray(value) ? value : []}
          onChange={(v) => set(v)}
          options={(attr.options || []).map((o) => ({ value: o, label: o }))}
          placeholder="None selected"
        />
      );
      break;
    case 'reference':
      control = <ReferencePicker attr={attr} value={value} onChange={(v) => set(v || null)} disabled={disabled} />;
      break;
    case 'date':
      control = <input {...common} type="date" value={(value ?? '').slice(0, 10)} onChange={(e) => set(e.target.value)} />;
      break;
    case 'datetime':
      control = <input {...common} type="datetime-local" value={String(value ?? '').slice(0, 16).replace(' ', 'T')} onChange={(e) => set(e.target.value)} />;
      break;
    case 'integer':
    case 'number':
      control = (
        <input
          {...common}
          type="number"
          step={attr.data_type === 'integer' ? 1 : 'any'}
          min={attr.min_value ?? undefined}
          max={attr.max_value ?? undefined}
          value={value ?? ''}
          onChange={(e) => set(e.target.value === '' ? null : e.target.value)}
        />
      );
      break;
    case 'url':
      control = <input {...common} type="url" placeholder="https://…" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'email':
      control = <input {...common} type="email" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'ip':
      control = <input {...common} placeholder="10.0.0.1" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    default:
      control = <input {...common} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
  }

  return (
    <div>
      <label className="label flex items-center gap-1.5 flex-wrap">
        <span>{attr.label}</span>
        {!!attr.required && <span className="text-red-500">*</span>}
        {!!attr.unit && <span className="text-slate-400 font-normal">({attr.unit})</span>}
        {!!attr.is_identifier && (
          <span
            className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
            title="Used to recognise this CI when discovery or an import sends it again"
          >
            <Link2 size={9} /> identifier
          </span>
        )}
        {/* Where an inherited field comes from, because "why does a Printer
            have this?" is otherwise a genuinely confusing question. */}
        {!!attr.inherited && (
          <span className="text-[10px] font-normal text-slate-400" title={`Inherited from ${attr.owner_class_label}`}>
            from {attr.owner_class_label}
          </span>
        )}
      </label>
      {control}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!error && attr.help_text && (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-slate-400">
          <Info size={11} className="mt-0.5 shrink-0" /> {attr.help_text}
        </p>
      )}
    </div>
  );
}

// Groups attributes by the class that declares them, so a Server form reads
// "Server / Hardware / Configuration Item" rather than as one flat list of
// thirty fields in no obvious order.
export function groupByOwner(attributes) {
  const groups = [];
  for (const attr of attributes) {
    const key = attr.owner_class_label || 'Fields';
    let group = groups.find((g) => g.label === key);
    if (!group) { group = { label: key, inherited: !!attr.inherited, attributes: [] }; groups.push(group); }
    group.attributes.push(attr);
  }
  return groups;
}
