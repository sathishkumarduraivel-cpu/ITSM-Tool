import { createPortal } from 'react-dom';
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
  const cardMotion = {
    initial: shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 },
    animate: shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 },
    transition: { type: 'spring', stiffness: 420, damping: 32 },
  };
  const closeButton = (
    <button
      type="button"
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
        className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
      >
        <motion.div {...cardMotion} className={`card w-full ${maxWidth} p-5 space-y-4 my-auto shadow-popover dark:shadow-popover-dark`}>
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
      className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 px-4 py-8 overflow-y-auto"
    >
      <motion.div {...cardMotion} className={`card w-full ${maxWidth} max-h-[88vh] flex flex-col overflow-hidden p-0 my-auto shadow-popover dark:shadow-popover-dark`}>
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
