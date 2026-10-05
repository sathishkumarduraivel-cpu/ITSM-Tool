import { useRef, useState } from 'react';
import { Loader2, Upload, Download, AlertTriangle, Check, FileText } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';

// CSV import, in four steps: choose the class, hand over the file, check the
// mapping, look at the dry run.
//
// The dry run is not optional and the commit button does not appear until it
// has been produced. Bulk import is the single easiest way to fill a CMDB
// with duplicates and half-populated rows, and the only reliable guard is
// making somebody look at what is about to happen first.
const ACTION_STYLE = {
  create: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  update: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  error: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  duplicate_in_file: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
};

export default function ImportWizard({ classes, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [classId, setClassId] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [inspection, setInspection] = useState(null);
  const [mapping, setMapping] = useState({});
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const concrete = classes.filter((c) => !c.is_abstract);

  const pickFile = async (file) => {
    if (!file) return;
    setError('');
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    setBusy(true);
    try {
      const data = await api.post('/itam/import/inspect', { csv: text, class_id: classId });
      setInspection(data);
      setMapping(data.mapping || {});
      setStep(3);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const runPreview = async () => {
    setBusy(true); setError('');
    try {
      setPreview(await api.post('/itam/import/preview', { csv, class_id: classId, mapping }));
      setStep(4);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true); setError('');
    try {
      setResult(await api.post('/itam/import/commit', { csv, class_id: classId, mapping }));
      setStep(5);
      onDone?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const downloadTemplate = async () => {
    // Fetched through the API client so the auth header goes with it, then
    // handed to the browser as a download.
    const token = localStorage.getItem('itsm_token');
    const resp = await fetch(`/api/itam/import/template/${classId}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await resp.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'cmdb-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="Import configuration items" onClose={onClose} maxWidth="max-w-3xl">
      <div className="space-y-4">
        <Steps step={step} />

        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div>
              <label className="label">What are you importing?<span className="text-red-500">*</span></label>
              <Select
                value={classId} onChange={setClassId} placeholder="Choose a CI class…"
                options={concrete.map((c) => ({ value: c.id, label: c.label }))}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Every row in the file becomes a CI of this class, and is validated against the fields that class declares.
              </p>
            </div>
            <div className="flex justify-between gap-2">
              <button onClick={downloadTemplate} disabled={!classId} className="btn-secondary text-xs disabled:opacity-40">
                <Download size={13} /> Download a template
              </button>
              <button onClick={() => setStep(2)} disabled={!classId} className="btn-primary text-xs disabled:opacity-40">Next</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 px-6 py-10 text-slate-500 transition-colors hover:border-brand-400 hover:text-brand-600 dark:border-slate-700 dark:text-slate-400"
            >
              {busy ? <Loader2 size={22} className="animate-spin" /> : <Upload size={22} />}
              <span className="text-sm font-medium">{busy ? 'Reading…' : 'Choose a CSV file'}</span>
              <span className="text-xs text-slate-400">Up to 5,000 rows. Quoted fields, commas and line breaks are all handled.</span>
            </button>
            <input
              ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <div className="flex justify-start">
              <button onClick={() => setStep(1)} className="btn-secondary text-xs">Back</button>
            </div>
          </div>
        )}

        {step === 3 && inspection && (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <FileText size={12} /> {fileName} · {inspection.row_count} row{inspection.row_count === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Columns are matched to fields automatically where the names line up. Check the ones that are not, and leave
              anything you do not want imported as <em>Ignore</em>.
            </p>
            <div className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-3 dark:border-white/10">
              {inspection.headers.map((h) => (
                <div key={h} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[140px] flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-300">{h}</span>
                  <span className="text-slate-300">→</span>
                  <Select
                    className="min-w-[200px] flex-1" size="sm"
                    value={mapping[h] || ''}
                    onChange={(v) => setMapping((m) => ({ ...m, [h]: v }))}
                    options={[
                      { value: '', label: 'Ignore this column' },
                      ...inspection.options.core.map((f) => ({ value: `core.${f.key}`, label: f.label })),
                      ...inspection.options.attributes.map((a) => ({
                        value: `attr.${a.key}`,
                        label: `${a.label}${a.required ? ' *' : ''}${a.is_identifier ? ' (identifier)' : ''}`,
                      })),
                    ]}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between gap-2">
              <button onClick={() => setStep(2)} className="btn-secondary text-xs">Back</button>
              <button onClick={runPreview} disabled={busy} className="btn-primary text-xs">
                {busy && <Loader2 size={12} className="animate-spin" />} Check what this would do
              </button>
            </div>
          </div>
        )}

        {step === 4 && preview && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              <Count label="Create" value={preview.counts.create} tone="create" />
              <Count label="Update" value={preview.counts.update} tone="update" />
              <Count label="Duplicate" value={preview.counts.duplicate_in_file} tone="duplicate_in_file" />
              <Count label="Error" value={preview.counts.error} tone="error" />
            </div>

            {preview.warnings?.length > 0 && (
              <div className="space-y-1 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                {preview.warnings.map((w) => (
                  <div key={w} className="flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</div>
                ))}
              </div>
            )}

            <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200 dark:border-white/10">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1.5 font-medium text-slate-500">Row</th>
                    <th className="px-2 py-1.5 font-medium text-slate-500">Outcome</th>
                    <th className="px-2 py-1.5 font-medium text-slate-500">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {preview.rows.map((r) => (
                    <tr key={r.row}>
                      <td className="px-2 py-1.5 text-slate-400">{r.row}</td>
                      <td className="px-2 py-1.5"><span className={`badge ${ACTION_STYLE[r.action]}`}>{r.action.replace(/_/g, ' ')}</span></td>
                      <td className="px-2 py-1.5 text-slate-600 dark:text-slate-300">
                        {r.action === 'error' && r.problems.join('; ')}
                        {r.action === 'update' && `Matches ${r.ci.name} on ${r.matched_by}`}
                        {r.action === 'duplicate_in_file' && `Same identifier as row ${r.duplicate_of_row}`}
                        {r.action === 'create' && (r.payload.name || r.payload.tag || 'New CI')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.truncated && <p className="text-[10px] text-slate-400">Showing the first 200 rows; the counts above cover all {preview.total}.</p>}

            <div className="flex justify-between gap-2">
              <button onClick={() => setStep(3)} className="btn-secondary text-xs">Back to mapping</button>
              <button onClick={commit} disabled={busy || (preview.counts.create + preview.counts.update === 0)} className="btn-primary text-xs disabled:opacity-40">
                {busy && <Loader2 size={12} className="animate-spin" />}
                Import {preview.counts.create + preview.counts.update} row{preview.counts.create + preview.counts.update === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        )}

        {step === 5 && result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <Check size={15} /> Imported.
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Count label="Created" value={result.summary.created} tone="create" />
              <Count label="Updated" value={result.summary.updated} tone="update" />
              <Count label="Unchanged" value={result.summary.unchanged} />
              <Count label="Skipped" value={result.summary.skipped} tone="duplicate_in_file" />
              <Count label="Failed" value={result.summary.failed} tone="error" />
            </div>
            {result.failures?.length > 0 && (
              <div className="max-h-40 space-y-1 overflow-y-auto text-xs">
                {result.failures.map((f) => (
                  <div key={f.row} className="rounded-md bg-red-50 px-2 py-1 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    Row {f.row}: {f.error}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <button onClick={onClose} className="btn-primary text-xs">Done</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Steps({ step }) {
  const labels = ['Class', 'File', 'Mapping', 'Dry run', 'Done'];
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold ${
            step > i + 1 ? 'bg-emerald-500 text-white'
              : step === i + 1 ? 'bg-brand-600 text-white'
                : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
          }`}>{step > i + 1 ? <Check size={11} /> : i + 1}</span>
          <span className={step === i + 1 ? 'font-medium text-slate-700 dark:text-slate-200' : 'text-slate-400'}>{label}</span>
          {i < labels.length - 1 && <span className="mx-0.5 h-px w-4 bg-slate-200 dark:bg-slate-700" />}
        </div>
      ))}
    </div>
  );
}

function Count({ label, value, tone }) {
  return (
    <div className={`rounded-xl px-2 py-1.5 text-center ${tone ? ACTION_STYLE[tone] : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
      <div className="font-display text-lg font-bold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
}
