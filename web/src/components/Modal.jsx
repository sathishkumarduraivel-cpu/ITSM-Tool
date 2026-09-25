import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

// Shared modal chrome (backdrop + card + title bar). Put your <form> (with its
// own submit/cancel buttons) as children — Modal only owns the shell so native
// form submit-on-Enter and validation keep working normally. Entrance-only
// motion (no AnimatePresence): the ~15 call sites across the app just mount
// this conditionally, so an exit animation would need every one of them
// wrapped individually -- not worth the churn for a close animation.
// `footer`, if passed, switches the card into a fixed-height, three-region
// layout (sticky header / independently-scrolling body / sticky footer) --
// for long forms where the action buttons should always stay reachable
// without scrolling past the whole form first. Omitted, the card behaves
// exactly as before (grows with content, whole thing scrolls with the page)
// so every existing call site is untouched.
//
// Portaled to document.body: this overlay is `position: fixed; inset: 0`,
// which is normally viewport-relative -- except `backdrop-filter` (and
// `filter`/`transform`/etc.) on ANY ancestor creates a new containing block
// for fixed descendants per spec. `.glass-panel`/`.card` both use
// backdrop-blur, so a Modal triggered from a component that lives inside
// one (e.g. the header) would get trapped inside that ancestor's own box
// instead of covering the screen -- invisible or clipped, not "not
// rendering". Portaling escapes every such ancestor unconditionally, so
// this can never happen regardless of where a call site is mounted.
export default function Modal({ title, onClose, maxWidth = 'max-w-lg', footer, headerActions, children }) {
  const shouldReduceMotion = useReducedMotion();
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  // Captured during the FIRST RENDER, not in the effect below, and this
  // timing is the whole point: React applies a child's `autoFocus` while it
  // commits the DOM, which is before any passive effect runs. Reading
  // document.activeElement from the effect therefore returned an input
  // INSIDE this modal, and restoring focus to it on unmount was a no-op
  // against a node that had just been removed -- so closing a dialog
  // dropped focus on <body> and keyboard users lost their place entirely.
  // During render the modal does not exist yet, so this is still whatever
  // the person was actually on when they opened it.
  const previouslyFocused = useRef(undefined);
  if (previouslyFocused.current === undefined) previouslyFocused.current = document.activeElement;

  // Focus management runs ONCE, on mount and unmount.
  //
  // This used to share an effect with the Escape handler below, keyed on
  // [onClose]. Almost every call site passes an inline arrow —
  // `onClose={() => setCreating(false)}` — which is a new function identity
  // on every render of the component that owns it. So typing a character
  // into a field whose state lives in that same component tore this effect
  // down and ran it again, and `closeRef.current.focus()` moved the caret
  // to the X button. One letter, then focus gone, and you had to click back
  // into the box for the next one -- which is exactly what it felt like.
  //
  // Whether a given box was affected came down to where its state lived: a
  // modal that kept its own state in a child component (the article editor)
  // never re-rendered its parent, so onClose stayed stable and it was fine.
  // That is why only some boxes misbehaved, which made it look arbitrary.
  //
  // Splitting them fixes every modal in the app at once, without any call
  // site having to remember to wrap its handler in useCallback.
  useEffect(() => {
    // Only pull focus in if nothing here has it already. A call site that
    // marked a field `autoFocus` has said where the cursor belongs, and it
    // is nearly always a better answer than the close button -- opening
    // "New catalog item" should put you in the Name box ready to type.
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    return () => {
      // isConnected: if whatever opened this has since been unmounted (a row
      // that was deleted, a list that reloaded) there is nothing to go back
      // to, and focusing a detached node just silently does nothing.
      const previous = previouslyFocused.current;
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);

  // The Escape listener genuinely does depend on the latest onClose, and
  // rebinding it is free — it touches no focus.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const cardMotion = {
    initial: shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 },
    animate: shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 },
    transition: { type: 'spring', stiffness: 420, damping: 32 },
  };
  const closeButton = (
    <button
      type="button"
      ref={closeRef}
      aria-label={`Close ${title}`}
      onClick={onClose}
      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1 transition-colors"
    >
      <X size={18} />
    </button>
  );
  // `headerActions` (e.g. an Edit button) sits to the left of the close
  // button, in the same row as the title -- an optional extra affordance a
  // few call sites need, everyone else just gets the plain title + close.
  const trailingActions = (
    <div className="flex items-center gap-1.5">
      {headerActions}
      {closeButton}
    </div>
  );

  if (!footer) {
    return createPortal(
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
      >
        <motion.div ref={dialogRef} {...cardMotion} className={`card w-full ${maxWidth} p-5 space-y-4 my-auto shadow-popover dark:shadow-popover-dark`}>
          <div className="flex items-center justify-between">
            <h2 className="font-display font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
            {trailingActions}
          </div>
          {children}
        </motion.div>
      </motion.div>,
      document.body
    );
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
    >
      <motion.div ref={dialogRef} {...cardMotion} className={`card w-full ${maxWidth} max-h-[88vh] flex flex-col overflow-hidden p-0 my-auto shadow-popover dark:shadow-popover-dark`}>
        <div className="flex items-center justify-between px-5 sm:px-6 pt-5 pb-4 border-b border-slate-100 dark:border-white/[0.06] shrink-0">
          <h2 className="font-display font-semibold text-lg text-slate-800 dark:text-slate-100">{title}</h2>
          {trailingActions}
        </div>
        <div className="overflow-y-auto flex-1 px-5 sm:px-6 py-5">
          {children}
        </div>
        <div className="px-5 sm:px-6 py-3.5 border-t border-slate-100 dark:border-white/[0.06] shrink-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur">
          {footer}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}
