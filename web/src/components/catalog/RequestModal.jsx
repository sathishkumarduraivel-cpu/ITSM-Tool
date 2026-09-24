import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, Clock, Wallet, ShieldCheck, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import RequestField, { visibleFields } from './RequestField.jsx';

const money = (n, currency = 'USD') => new Intl.NumberFormat(undefined, {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(n || 0);

// Ordering something from the catalog.
//
// Two things this does that the old form did not: it only shows the questions
// that apply (and the server discards anything else, so the two agree), and it
// tells the requester up front what will happen -- who has to approve it and
// when it should arrive. A request that disappears into an approval queue
// nobody mentioned is the main reason people stop using a catalog.
export default function RequestModal({ item, onClose, onSubmitted }) {
  const [values, setValues] = useState({});
  const [quantity, setQuantity] = useState(1);
  const [requestedFor, setRequestedFor] = useState('');
  const [people, setPeople] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const schema = item.form_schema || [];
  const shown = useMemo(() => visibleFields(schema, values), [schema, values]);

  useEffect(() => {
    if (!item.allow_on_behalf) return;
    api.get('/tickets/assignable-agents').then((d) => setPeople(d.agents || [])).catch(() => {});
  }, [item.allow_on_behalf]);

  const set = (key, v) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setFieldErrors((e) => { const { [key]: _drop, ...rest } = e; return rest; });
  };

  const cost = item.cost != null ? Number(item.cost) * quantity : null;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(''); setFieldErrors({});
    try {
      // Only what is on screen is sent. The server discards hidden answers
      // anyway, but there is no reason to post them in the first place.
      const payload = Object.fromEntries(shown.filter((f) => values[f.key] !== undefined).map((f) => [f.key, values[f.key]]));
      const result = await api.post(`/catalog/items/${item.id}/request`, {
        form_data: payload,
        quantity,
        requested_for_id: requestedFor || undefined,
      });
      // The chain travels with the ticket so the confirmation can show what
      // still has to happen, rather than leaving the requester guessing.
      onSubmitted(result.ticket, result.approval_chain || []);
    } catch (err) {
      const detail = err.body?.field_errors;
      if (Array.isArray(detail) && detail.length) {
        setFieldErrors(Object.fromEntries(detail.map((f) => [f.field, f.message])));
        setError('Some answers need attention.');
      } else setError(err.message);
    } finally { setSaving(false); }
  };

  return (
    <Modal title={item.name} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {(item.short_description || item.description) && (
          <p className="text-sm text-slate-600 dark:text-slate-300">{item.short_description || item.description}</p>
        )}

        {/* What happens next, said before they commit rather than after. */}
        <div className="flex flex-wrap gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs dark:bg-slate-800/60">
          {item.delivery_days != null && (
            <span className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <Clock size={12} /> Expected within {item.delivery_days} day{Number(item.delivery_days) === 1 ? '' : 's'}
            </span>
          )}
          {cost != null && (
            <span className="flex items-center gap-1 text-slate-600 dark:text-slate-300">
              <Wallet size={12} /> {money(cost, item.currency)}
            </span>
          )}
          {!!item.approval_required && (
            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <ShieldCheck size={12} /> Needs approval before it starts
            </span>
          )}
        </div>

        {shown.map((field) => (
          <RequestField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={set}
            error={fieldErrors[field.key]}
          />
        ))}

        {schema.length > 0 && shown.length === 0 && (
          <p className="text-xs text-slate-400">No further details needed.</p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {item.max_quantity > 1 && (
            <div>
              <label className="label">How many</label>
              <input
                className="input" type="number" min={1} max={item.max_quantity}
                value={quantity}
                onChange={(e) => setQuantity(Math.min(item.max_quantity, Math.max(1, Number(e.target.value) || 1)))}
              />
              <p className="mt-1 text-[11px] text-slate-400">Up to {item.max_quantity}.</p>
            </div>
          )}
          {!!item.allow_on_behalf && (
            <div>
              <label className="label flex items-center gap-1"><Users size={11} /> Requesting for</label>
              <Select
                value={requestedFor} onChange={setRequestedFor} placeholder="Myself"
                options={[{ value: '', label: 'Myself' }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={14} className="animate-spin" />} Submit request
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Shown after submitting: what was raised, and what happens to it next.
export function RequestSubmitted({ ticket, chain, onClose }) {
  const navigate = useNavigate();
  return (
    <Modal title="Request submitted" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
          <span><strong>{ticket.number}</strong> has been raised.</span>
        </div>

        {chain?.length > 0 ? (
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Approval needed</div>
            <div className="space-y-1">
              {chain.map((s, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold dark:bg-slate-700">
                    {s.step_order}
                  </span>
                  <span className="text-slate-700 dark:text-slate-200">{s.name}</span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">Work starts once every stage has approved it.</p>
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">No approval is needed, so this has gone straight to the service desk.</p>
        )}

        {ticket.fulfilment_due_at && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Expected by {String(ticket.fulfilment_due_at).slice(0, 10)}.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Close</button>
          <button onClick={() => navigate(`/tickets/${ticket.id}`)} className="btn-primary">Track it</button>
        </div>
      </div>
    </Modal>
  );
}
