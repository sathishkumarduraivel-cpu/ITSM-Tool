import { X } from 'lucide-react';

// Shared modal chrome (backdrop + card + title bar). Put your <form> (with its
// own submit/cancel buttons) as children — Modal only owns the shell so native
// form submit-on-Enter and validation keep working normally.
export default function Modal({ title, onClose, maxWidth = 'max-w-lg', children }) {
  return (
    <div className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 px-4 py-8 overflow-y-auto animate-fade-in">
      <div className={`card w-full ${maxWidth} p-5 space-y-4 my-auto shadow-popover dark:shadow-popover-dark animate-pop-in`}>
        <div className="flex items-center justify-between">
          <h2 className="font-display font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
