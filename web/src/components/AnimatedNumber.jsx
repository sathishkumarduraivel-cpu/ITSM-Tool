import { useEffect } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';

// Springs a numeric (optionally suffixed, e.g. "42%") value to its target
// instead of snapping instantly -- the small "alive, computed live" detail
// that separates a real-time ops dashboard from a static report.
export default function AnimatedNumber({ value }) {
  const match = typeof value === 'string' ? value.match(/^(-?[\d.]+)(.*)$/) : null;
  const numeric = match ? parseFloat(match[1]) : (typeof value === 'number' ? value : null);
  const suffix = match ? match[2] : '';
  const isInt = numeric === null || Number.isInteger(numeric);

  const motionVal = useMotionValue(0);
  const spring = useSpring(motionVal, { stiffness: 120, damping: 20, mass: 0.6 });
  const display = useTransform(spring, (v) => (isInt ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)));

  useEffect(() => {
    if (numeric !== null) motionVal.set(numeric);
  }, [numeric, motionVal]);

  if (numeric === null) return <>{value}</>;
  return (
    <>
      <motion.span>{display}</motion.span>
      {suffix}
    </>
  );
}
