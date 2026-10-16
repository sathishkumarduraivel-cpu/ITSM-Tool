import { forwardRef, useEffect, useState } from 'react';
import { Sparkles, Loader2, Check, X, Undo2 } from 'lucide-react';
import { api } from '../lib/api.js';

// Below this there is nothing for Sona to polish, and a button on an empty
// field is just noise.
const MIN_CHARS = 8;

/**
 * A drop-in <textarea> with Sona's writing assistant attached.
 *
 * Every prop goes straight to the textarea, so swapping one in changes
 * nothing about how the field behaves. Once there is something written, an
 * "Improve" pill appears in the corner; Sona's rewrite is shown as a
 * suggestion beside the original and only replaces it when the person
 * accepts -- their text is never overwritten behind their back, and an
 * accepted rewrite can be undone until they type again.
 *
 * `purpose` is the field's name ("Backout plan", "Reply to requester") and
 * tells Sona what kind of text it is. `wrapperClassName` carries layout
 * classes (flex-1, col-span-2, margins) that used to sit on the textarea,
 * since the wrapper is now the element its parent lays out. The field must be
 * controlled (value + onChange) -- Sona can only polish text it can see.
 */
const SonaTextarea = forwardRef(function SonaTextarea(
  { purpose = '', wrapperClassName = '', className = '', value, onChange, onSonaApply, disabled, readOnly, ...rest },
  ref,
) {
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState(null); // { from, text }
  const [previous, setPrevious] = useState(null); // { from, to } after accepting, for undo
  const [error, setError] = useState('');

  const text = String(value ?? '');
  const canImprove = !disabled && !readOnly && text.trim().length >= MIN_CHARS;

  // Typing after a suggestion or an accept means the person has moved on;
  // the stale suggestion and the undo both refer to text that is gone.
  useEffect(() => {
    if (suggestion && text !== suggestion.from) setSuggestion(null);
    if (previous && text !== previous.to) setPrevious(null);
    if (error) setError('');
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handlers in this codebase read e.target.value, so a minimal event-shaped
  // object is enough to route Sona's text through the field's own onChange.
  // onSonaApply is for fields that persist on blur: accepting a suggestion is
  // a click elsewhere, so no blur reaches the textarea and it would never save.
  const emit = (next) => {
    onChange?.({ target: { value: next }, currentTarget: { value: next } });
    onSonaApply?.(next);
  };

  const improve = async () => {
    setBusy(true); setError(''); setPrevious(null);
    try {
      const out = await api.post('/ai/improve-text', { text, purpose });
      if (out.text.trim() === text.trim()) setError('Sona had nothing to change — it already reads well.');
      else setSuggestion({ from: text, text: out.text });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    setPrevious({ from: suggestion.from, to: suggestion.text });
    setSuggestion(null);
    emit(suggestion.text);
  };

  const undo = () => {
    const restore = previous.from;
    setPrevious(null);
    emit(restore);
  };

  return (
    <div className={`relative ${wrapperClassName}`}>
      <textarea
        ref={ref}
        className={`${className} ${canImprove || busy ? 'pb-8' : ''}`}
        value={value}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        {...rest}
      />

      {(canImprove || busy) && !suggestion && (
        <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1">
          {previous && !busy && (
            <button
              type="button" onClick={undo}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-slate-500 shadow-sm ring-1 ring-slate-200 transition-colors hover:text-slate-700 dark:bg-slate-800/90 dark:text-slate-300 dark:ring-white/10"
            >
              <Undo2 size={11} /> Undo
            </button>
          )}
          <button
            type="button" onClick={improve} disabled={busy}
            title="Sona rewrites this for clarity and grammar — you review it before it replaces anything"
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-brand-700 shadow-sm ring-1 ring-brand-200 transition-colors hover:bg-brand-50 disabled:opacity-70 dark:bg-slate-800/90 dark:text-brand-300 dark:ring-brand-500/30 dark:hover:bg-brand-500/10"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {busy ? 'Improving…' : 'Improve with Sona'}
          </button>
        </div>
      )}

      {suggestion && (
        <div className="mt-1.5 rounded-xl border border-brand-200 bg-brand-50/60 p-2.5 dark:border-brand-500/30 dark:bg-brand-500/10">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-brand-700 dark:text-brand-300">
            <Sparkles size={11} /> Sona suggests
          </div>
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{suggestion.text}</p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setSuggestion(null)} className="btn-secondary px-2.5 py-1 text-xs">
              <X size={12} /> Keep mine
            </button>
            <button type="button" onClick={accept} className="btn-primary px-2.5 py-1 text-xs">
              <Check size={12} /> Use this
            </button>
          </div>
        </div>
      )}

      {error && !suggestion && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{error}</p>}
    </div>
  );
});

export default SonaTextarea;
