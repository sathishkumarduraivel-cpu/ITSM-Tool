import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

const ToastContext = createContext({ showToast: () => {} });

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
const TONES = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
  info: 'border-brand-200 bg-white text-slate-800 dark:border-brand-500/30 dark:bg-slate-900 dark:text-slate-100',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const showToast = (message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current.slice(-3), { id, message, type }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), type === 'error' ? 6000 : 4000);
  };

  useEffect(() => {
    const onToast = (event) => showToast(event.detail?.message, event.detail?.type);
    window.addEventListener('itsm:toast', onToast);
    return () => window.removeEventListener('itsm:toast', onToast);
  }, []);

  const value = useMemo(() => ({ showToast }), []);
  return <ToastContext.Provider value={value}>{children}<div className="fixed right-4 top-4 z-[200] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" aria-atomic="true"><AnimatePresence>{toasts.map((toast) => { const Icon = ICONS[toast.type] || Info; return <motion.div key={toast.id} initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 24 }} className={`flex items-start gap-3 rounded-xl border p-3.5 shadow-popover ${TONES[toast.type] || TONES.info}`}><Icon size={18} className="mt-0.5 shrink-0" /><p className="flex-1 text-sm font-medium">{toast.message}</p><button aria-label="Dismiss notification" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} className="rounded p-0.5 opacity-60 hover:opacity-100"><X size={15} /></button></motion.div>; })}</AnimatePresence></div></ToastContext.Provider>;
}

export const useToast = () => useContext(ToastContext);
