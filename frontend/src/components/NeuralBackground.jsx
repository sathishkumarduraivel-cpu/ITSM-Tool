import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

// Ambient "neural network" canvas — particles connect into a live graph and
// react to the cursor. Ported from a supplied standalone HTML/canvas script
// rather than dropped in verbatim: the original had four real integration
// gaps against this app --
//   1. hardcoded sky-blue (#38bdf8) instead of this app's actual "AI/live
//      signal" token (the neon-cyan scale in tailwind.config.js), and no
//      light-mode palette at all -- it would render broken/washed-out
//      whenever someone had switched out of the (default) dark theme;
//   2. particle count scaled unbounded with screen area (area/12000, so a
//      4K monitor spawns ~690 particles => ~475k pairwise distance checks
//      every frame) -- exactly the kind of jank the app's own animation
//      guidance rules out;
//   3. no cleanup: raw window/document listeners and an uncancelled
//      requestAnimationFrame loop would leak on every unmount;
//   4. no reduced-motion or tab-visibility handling.
// This version fixes all four while keeping the original's actual visual
// idea (pulsing glow, mouse-repel, distance-based connection fade).
const MAX_PARTICLES = 90;
const CONNECT_DISTANCE = 150;
const MOUSE_RADIUS = 180;

const PALETTE = {
  // neon-400 / neon-600 from tailwind.config.js — the app's existing "AI /
  // live signal" accent, not a new color introduced by this component.
  dark: { particle: '94,179,255', glow: '#0B74E0', lineAlpha: 0.22, opacity: 0.7 },
  // brand-500 / brand-700 — on a light background the dark theme's azure
  // reads as washed-out neon; the existing light-mode orbs on this same
  // page already use brand/teal at low opacity, so the network matches
  // that instead of clashing with it. Kept much fainter than dark mode's --
  // light mode is this app's clean/flat identity, dark mode is where the
  // full "live console" effect belongs.
  light: { particle: '6,182,212', glow: '#0E7490', lineAlpha: 0.07, opacity: 0.16 },
};

function useIsDark() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

// `intensity` scales the base opacity down for ambient, persistent use (e.g.
// mounted once behind the whole logged-in app) without touching the more
// prominent default used on the Login/Register hero.
export default function NeuralBackground({ intensity = 1 }) {
  const canvasRef = useRef(null);
  const shouldReduceMotion = useReducedMotion();
  const isDark = useIsDark();
  const theme = isDark ? PALETTE.dark : PALETTE.light;

  useEffect(() => {
    if (shouldReduceMotion) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let particles = [];
    let raf = null;
    let running = true;

    const mouse = { x: null, y: null };

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(MAX_PARTICLES, Math.floor((w * h) / 14000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: Math.random() * 1.6 + 1,
        pulse: Math.random() * Math.PI,
      }));
    }

    function onMouseMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; }
    function onMouseLeave() { mouse.x = null; mouse.y = null; }
    function onVisibility() {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(tick);
    }

    function tick() {
      if (!running) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < CONNECT_DISTANCE) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(${theme.particle}, ${(1 - dist / CONNECT_DISTANCE) * theme.lineAlpha})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        p.pulse += 0.03;

        if (mouse.x != null) {
          const dx = mouse.x - p.x;
          const dy = mouse.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist < MOUSE_RADIUS && dist > 0) {
            const force = (MOUSE_RADIUS - dist) / MOUSE_RADIUS;
            p.x -= (dx / dist) * force * 1.6;
            p.y -= (dy / dist) * force * 1.6;
          }
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + Math.sin(p.pulse) * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${theme.particle})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = theme.glow;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(tick);
    }

    resize();
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [shouldReduceMotion, theme]);

  // Static, non-animated: respects prefers-reduced-motion by simply not
  // running the effect above rather than trying to fake a "reduced" canvas.
  if (shouldReduceMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ opacity: theme.opacity * intensity }}
    />
  );
}
