import { useEffect, useRef, useState } from 'react';
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
export default function Select({
  value, onChange, options, placeholder = 'Select…', className = '', disabled = false, searchable, size = 'md', align = 'left', variant = 'default', title,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);

  const normalized = options.map((o) => (typeof o === 'string' || typeof o === 'number' ? { value: o, label: String(o) } : o));
  const shouldSearch = searchable ?? normalized.length > 8;
  const filtered = shouldSearch && query.trim()
    ? normalized.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : normalized;
  const selected = normalized.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + window.scrollY + 6,
        left: (align === 'right' ? rect.right - Math.max(rect.width, 180) : rect.left) + window.scrollX,
        width: Math.max(rect.width, 180),
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
        <span className={`truncate flex items-center gap-1.5 min-w-0 ${!isBadge && !selected ? 'text-slate-400' : ''}`}>
          {selected?.icon && <selected.icon size={13} className="shrink-0" />}
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={isBadge ? 10 : 14} className={`shrink-0 ${isBadge ? '' : 'text-slate-400'} transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{ position: 'absolute', top: pos.top, left: pos.left, minWidth: pos.width }}
              className="z-[200] card shadow-popover dark:shadow-popover-dark p-1.5 max-h-72 overflow-y-auto"
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
                      layoutId={`select-highlight-${pos.top}`}
                      className="absolute inset-0 rounded-lg bg-brand-50 dark:bg-brand-500/10"
                      transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                    />
                  )}
                  {o.icon && <o.icon size={14} className="relative shrink-0 text-slate-400" />}
                  <span className="relative truncate flex-1">{o.label}</span>
                  {o.value === value && <Check size={13} className="relative text-brand-600 dark:text-brand-400 shrink-0" />}
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
