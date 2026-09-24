import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, Search } from 'lucide-react';

// Replaces the native <select> everywhere it appears -- browser-native
// dropdowns can't be styled to match this app's glass/gradient/motion
// language at all (no control over the popup's chrome), so this renders its
// own panel through a portal instead, same "escape the parent's stacking
// context" fix already used for Modal and TicketDetail's action menus.
//
// `options`: array of strings, or {value, label, icon?} objects.
// `searchable`: defaults to auto (on once there are more than 8 options).
// `multiple`: `value` becomes an array and `onChange` receives an array. The
//   panel stays open while picking, each row gets a checkbox, and the trigger
//   summarizes the selection. Used for genuinely multi-value fields like a
//   ticket's subcategory -- everything else keeps the single-select behavior
//   unchanged, so this prop is purely additive.
export default function Select({
  value, onChange, options, placeholder = 'Select…', className = '', disabled = false, searchable, size = 'md', align = 'left', variant = 'default', title,
  multiple = false, maxSummary = 2,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const panelId = useId();

  const normalized = options.map((o) => (typeof o === 'string' || typeof o === 'number' ? { value: o, label: String(o) } : o));
  const shouldSearch = searchable ?? normalized.length > 8;
  const filtered = shouldSearch && query.trim()
    ? normalized.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : normalized;
  const selectedValues = multiple ? (Array.isArray(value) ? value : []) : [];
  const isPicked = (optValue) => (multiple ? selectedValues.includes(optValue) : optValue === value);
  const selected = multiple ? null : normalized.find((o) => o.value === value);

  // Trigger text for multi-select: names while they fit, then a count, so a
  // long selection never blows out the control's width.
  const multiLabel = (() => {
    if (!multiple) return null;
    const labels = selectedValues
      .map((v) => normalized.find((o) => o.value === v)?.label ?? v);
    if (!labels.length) return null;
    if (labels.length <= maxSummary) return labels.join(', ');
    return `${labels.slice(0, maxSummary).join(', ')} +${labels.length - maxSummary}`;
  })();

  useEffect(() => {
    if (!open) return undefined;
    // The panel is positioned against the VIEWPORT, not the document, and
    // flips above the trigger when there isn't room below it. A dropdown near
    // the bottom of the window used to open downwards off-screen, and because
    // the panel is portaled to <body> there was often nothing left to scroll
    // to reach it -- inside a modal or a fixed-height pane it was simply
    // unreachable. Fixed positioning also means the same numbers work whether
    // the page scrolls or an inner pane does; the scroll listener below
    // re-measures either way so the panel stays glued to its trigger.
    const measure = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      const GAP = 6;
      const EDGE = 12; // never let the panel touch the window edge
      const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
      const spaceAbove = rect.top - GAP - EDGE;
      // Only flip when it genuinely buys more room, so a dropdown in the
      // middle of the page keeps its usual downward behaviour.
      const dropUp = spaceBelow < 200 && spaceAbove > spaceBelow;

      const width = Math.max(rect.width, 180);
      const rawLeft = align === 'right' ? rect.right - width : rect.left;
      const left = Math.min(Math.max(EDGE, rawLeft), Math.max(EDGE, window.innerWidth - width - EDGE));

      setPos({
        dropUp,
        top: dropUp ? undefined : rect.bottom + GAP,
        bottom: dropUp ? window.innerHeight - rect.top + GAP : undefined,
        left,
        width,
        // Whatever room is actually available, so the list scrolls inside the
        // panel instead of the panel spilling out of the window.
        maxHeight: Math.min(288, Math.max(120, dropUp ? spaceAbove : spaceBelow)),
      });
    };
    measure();
    setQuery('');
    const idx = normalized.findIndex((o) => o.value === value);
    setHighlighted(idx >= 0 ? idx : 0);
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (!triggerRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const commit = (opt) => {
    if (opt.disabled) return;
    if (multiple) {
      // Emitted in the options' own order rather than click order, so two
      // people picking the same set produce the same stored value.
      const next = selectedValues.includes(opt.value)
        ? selectedValues.filter((v) => v !== opt.value)
        : normalized.filter((o) => o.value === opt.value || selectedValues.includes(o.value)).map((o) => o.value);
      onChange(next);
      return; // panel stays open -- picking several is the whole point
    }
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlighted]) commit(filtered[highlighted]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
  };

  const sizeCls = size === 'sm' ? 'py-1.5 text-xs' : size === 'xs' ? 'py-1 px-2 text-xs' : 'py-2 text-sm';
  // Badge variant: a status/label pill that happens to be a dropdown (e.g. a
  // task's status shown as a colored badge) -- skips the .input chrome and
  // sizeCls entirely so the caller's className fully controls the pill look.
  const isBadge = variant === 'badge';

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={`${isBadge ? 'badge border-none cursor-pointer' : `input ${sizeCls}`} flex items-center justify-between ${isBadge ? 'gap-1' : 'gap-2'} text-left disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        <span className={`truncate flex items-center gap-1.5 min-w-0 ${!isBadge && !(multiple ? multiLabel : selected) ? 'text-slate-400' : ''}`}>
          {selected?.icon && <selected.icon size={13} className="shrink-0" />}
          {multiple ? (multiLabel || placeholder) : (selected ? selected.label : placeholder)}
        </span>
        <ChevronDown size={isBadge ? 10 : 14} className={`shrink-0 ${isBadge ? '' : 'text-slate-400'} transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: pos.dropUp ? 6 : -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: pos.dropUp ? 6 : -6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{
                position: 'fixed',
                top: pos.top,
                bottom: pos.bottom,
                left: pos.left,
                minWidth: pos.width,
                maxHeight: pos.maxHeight,
              }}
              className="z-[200] card shadow-popover dark:shadow-popover-dark p-1.5 overflow-y-auto overscroll-contain"
            >
              {shouldSearch && (
                <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 border-b border-slate-100 dark:border-slate-800">
                  <Search size={12} className="text-slate-400 shrink-0" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setHighlighted(0); }}
                    onKeyDown={onKeyDown}
                    placeholder="Search…"
                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
                  />
                </div>
              )}
              {filtered.length === 0 && <div className="px-2.5 py-2 text-xs text-slate-400 text-center">No matches</div>}
              {filtered.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={o.disabled}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => commit(o)}
                  className={`relative w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    i === highlighted ? 'text-brand-700 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {i === highlighted && (
                    <motion.span
                      layoutId={`select-highlight-${panelId}`}
                      className="absolute inset-0 rounded-lg bg-brand-50 dark:bg-brand-500/10"
                      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                    />
                  )}
                  {multiple && (
                    <span className={`relative grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors ${
                      isPicked(o.value)
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    }`}>
                      {isPicked(o.value) && <Check size={11} />}
                    </span>
                  )}
                  {o.icon && <o.icon size={14} className="relative shrink-0 text-slate-400" />}
                  <span className="relative truncate flex-1">{o.label}</span>
                  {!multiple && isPicked(o.value) && <Check size={13} className="relative text-brand-600 dark:text-brand-400 shrink-0" />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
