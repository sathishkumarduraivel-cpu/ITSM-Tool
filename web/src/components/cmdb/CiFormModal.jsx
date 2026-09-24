import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import AttributeField, { groupByOwner } from './AttributeField.jsx';

// Create or edit a CI. The form is built from the chosen class's schema, so
// it changes shape as soon as the class changes -- picking "Database" asks
// for an engine and a port, picking "Business Service" asks for an SLA tier
// and an RTO, and neither one is written into this component.
//
// Server-side field errors are mapped back onto the individual inputs rather
// than shown as one banner: a form that says "some fields need attention"
// without saying which is barely better than no message at all.
export default function CiFormModal({ initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState(initial?.ci_class?.id || initial?.class_id || '');
  const [schema, setSchema] = useState(null);
  const [core, setCore] = useState({
    tag: initial?.tag || '',
    name: initial?.name || '',
    status: initial?.status || 'in_use',
    location: initial?.location || '',
    vendor: initial?.vendor || '',
  });
  const [attrs, setAttrs] = useState(initial?.attributes || {});
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingSchema, setLoadingSchema] = useState(false);

  useEffect(() => {
    api.get('/assets/form-schema')
      .then((d) => setClasses(d.classes || []))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!classId) { setSchema(null); return; }
    setLoadingSchema(true);
    api.get(`/assets/form-schema?class_id=${classId}`)
      .then(setSchema)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingSchema(false));
  }, [classId]);

  const groups = useMemo(() => groupByOwner(schema?.attributes || []), [schema]);

  const setAttr = (key, value) => {
    setAttrs((a) => ({ ...a, [key]: value }));
    setFieldErrors((e) => { const { [key]: _drop, ...rest } = e; return rest; });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setFieldErrors({});
    try {
      const body = { ...core, class_id: classId || null, attributes: classId ? attrs : undefined };
      if (editing) await api.patch(`/assets/${initial.id}`, body);
      else await api.post('/assets', body);
      onSaved();
    } catch (err) {
      // The server returns { error, field_errors: [{attr_key, message}] }.
      const detail = err.body?.field_errors;
      if (Array.isArray(detail) && detail.length) {
        setFieldErrors(Object.fromEntries(detail.map((f) => [f.attr_key, f.message])));
        setError('Some fields need attention.');
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const chosen = classes.find((c) => c.id === classId);
  const isAssetClass = schema ? schema.is_asset : true;

  return (
    <Modal
      title={editing ? `Edit ${initial.name}` : 'New configuration item'}
      onClose={onClose}
      maxWidth="max-w-3xl"
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div>
          <label className="label">CI class<span className="text-red-500">*</span></label>
          <Select
            value={classId}
            onChange={setClassId}
            placeholder="Choose what this is…"
            options={classes.map((c) => ({ value: c.id, label: c.label }))}
          />
          {chosen?.description && <p className="mt-1 text-[11px] text-slate-400">{chosen.description}</p>}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Asset tag<span className="text-red-500">*</span></label>
            <input className="input" required value={core.tag} onChange={(e) => setCore({ ...core, tag: e.target.value })} />
          </div>
          <div>
            <label className="label">Name<span className="text-red-500">*</span></label>
            <input className="input" required value={core.name} onChange={(e) => setCore({ ...core, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Operational status</label>
            <Select
              value={core.status}
              onChange={(v) => setCore({ ...core, status: v })}
              options={['in_use', 'in_stock', 'maintenance', 'retired'].map((s) => ({ value: s, label: s.replace('_', ' ') }))}
            />
          </div>
          <div>
            <label className="label">Location</label>
            <input className="input" value={core.location} onChange={(e) => setCore({ ...core, location: e.target.value })} />
          </div>
          {/* Vendor only means something for a thing somebody bought. A
              business service has no vendor, and showing the box invites
              somebody to fill it in with nonsense. */}
          {isAssetClass && (
            <div>
              <label className="label">Vendor</label>
              <input className="input" value={core.vendor} onChange={(e) => setCore({ ...core, vendor: e.target.value })} />
            </div>
          )}
        </div>

        {loadingSchema && (
          <p className="flex items-center gap-2 py-4 text-sm text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading the fields for this class…
          </p>
        )}

        {!loadingSchema && groups.map((group) => (
          <div key={group.label} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {group.label}
              {group.inherited && <span className="font-normal normal-case text-slate-300 dark:text-slate-600">inherited</span>}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {group.attributes.map((attr) => (
                <AttributeField
                  key={attr.attr_key}
                  attr={attr}
                  value={attrs[attr.attr_key]}
                  onChange={setAttr}
                  error={fieldErrors[attr.attr_key]}
                />
              ))}
            </div>
          </div>
        ))}

        {!classId && (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            Pick a class to see the fields it expects. The class decides what this CI means and what it must record.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Save changes' : 'Create CI'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
