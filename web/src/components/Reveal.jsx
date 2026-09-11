import { motion } from 'framer-motion';

// Drop RevealGroup around any list/grid and RevealItem around each entry to
// get a staggered entrance for free -- no per-page animation code needed.
// Shared variants so every staggered list in the app moves the same way.
const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 28 } },
};

export function RevealGroup({ className, as: Component = motion.div, children, ...rest }) {
  return (
    <Component variants={container} initial="hidden" animate="show" className={className} {...rest}>
      {children}
    </Component>
  );
}

export function RevealItem({ className, as: Component = motion.div, children, ...rest }) {
  return (
    <Component variants={item} className={className} {...rest}>
      {children}
    </Component>
  );
}
