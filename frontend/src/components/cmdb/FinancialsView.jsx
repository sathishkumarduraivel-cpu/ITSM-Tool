import { useEffect, useState } from 'react';
import { Loader2, Wallet, CalendarClock, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';

const money = (n, currency = 'USD') => new Intl.NumberFormat(undefined, {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(n || 0);

// What the estate cost, what it is worth now, and what is about to run out.
//
// The two cuts shown are by class and by cost centre, because those are the
// two questions actually asked: "what are we carrying in laptops" and "what
// does this department own". Assets nobody has costed are counted separately
// rather than folded in as zero — a total that looks complete when it is not
// is worse than one that admits the gap.
export default function FinancialsView() {
  const [data, setData] = useState(null);
  const [expiring, setExpiring] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/itam/portfolio').then(setData).catch((e) => setError(e.message));
    api.get('/itam/expiring?days=90').then(setExpiring).catch(() => setExpiring(null));
  }, []);

  if (error) {
    return (
      <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (!data) return <Loading />;

  const currency = data.totals.currency;

  if (data.totals.assets_with_financials === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Nothing costed yet"
        description="Open a CI, go to Financials and record what it cost and how long it is expected to last. Book value and depreciation are worked out from there — there is nothing to keep up to date."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Purchase cost" value={money(data.totals.purchase_cost, currency)} />
        <Stat label="Book value today" value={money(data.totals.book_value, currency)} />
        <Stat label="Depreciated so far" value={money(data.totals.accumulated_depreciation, currency)} />
        <Stat label="Annual support" value={money(data.totals.annual_support_cost, currency)} />
      </div>

      {data.totals.unvalued > 0 && (
        <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {data.totals.unvalued} asset{data.totals.unvalued === 1 ? ' has' : 's have'} a financial record with no cost on it, so
          {' '}{data.totals.unvalued === 1 ? 'it is' : 'they are'} excluded from these totals rather than counted as zero.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="By CI class" rows={data.by_class} keyOf={(r) => r.key} nameOf={(r) => r.label} currency={currency} />
        <Breakdown title="By cost centre" rows={data.by_cost_centre} keyOf={(r) => r.cost_centre} nameOf={(r) => r.cost_centre} currency={currency} />
      </div>

      {expiring && (
        <div className="card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <CalendarClock size={14} /> Running out within {expiring.horizon_days} days
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ExpiryList title="Warranties" items={expiring.warranties} nameOf={(w) => w.name} dateOf={(w) => w.warranty_expiry} />
            <ExpiryList title="Contracts" items={expiring.contracts} nameOf={(c) => `${c.vendor} — ${c.name}`} dateOf={(c) => c.end_date} />
            <ExpiryList title="Licences" items={expiring.licences} nameOf={(l) => l.product_name} dateOf={(l) => l.expiry_date} />
          </div>
        </div>
      )}
    </div>
  );
}

function Breakdown({ title, rows, keyOf, nameOf, currency }) {
  const max = Math.max(1, ...rows.map((r) => r.book_value));
  return (
    <div className="card p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
      {rows.length === 0 && <p className="text-xs text-slate-400">Nothing recorded.</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={keyOf(r)}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-slate-700 dark:text-slate-200">{nameOf(r)}</span>
              <span className="shrink-0 text-slate-400">
                {r.count} · {money(r.book_value, currency)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${(r.book_value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExpiryList({ title, items, nameOf, dateOf }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">Nothing due.</p>
      ) : (
        <div className="space-y-1">
          {items.slice(0, 8).map((i) => (
            <div
              key={i.id}
              className={`rounded-md px-2 py-1 text-xs ${
                // Already gone is a different problem from about to go.
                i.expired
                  ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
              }`}
            >
              <div className="truncate">{nameOf(i)}</div>
              <div className="text-[10px] opacity-70">{i.expired ? 'expired ' : 'expires '}{String(dateOf(i)).slice(0, 10)}</div>
            </div>
          ))}
          {items.length > 8 && <div className="text-[10px] text-slate-400">+{items.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-display text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
    </div>
  );
}

function Loading() {
  return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>;
}
