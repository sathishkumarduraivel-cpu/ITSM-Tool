import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

// Wraps every route's content in AppShell so navigating between pages feels
// like one continuous app instead of a hard cut -- zero per-page work since
// this sits above {children} once. Keyed by pathname so React (and
// AnimatePresence) treats each route as a distinct entering/exiting node.
export default function PageTransition({ children }) {
  const location = useLocation();
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) return <div key={location.pathname}>{children}</div>;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
