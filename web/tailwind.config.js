/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Inter Tight"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      boxShadow: {
        soft: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 6px -1px rgb(0 0 0 / 0.06)',
        // Layered "3D" elevation — several stacked shadows at increasing blur/spread
        // read as real depth instead of a single flat drop-shadow.
        card: '0 0.5px 0 rgb(255 255 255 / 0.8) inset, 0 1px 1px rgb(15 23 42 / 0.03), 0 2px 6px -1px rgb(15 23 42 / 0.05), 0 8px 20px -6px rgb(15 23 42 / 0.08)',
        'card-dark': '0 1px 0 rgb(255 255 255 / 0.06) inset, 0 2px 6px -1px rgb(0 0 0 / 0.3), 0 12px 28px -8px rgb(0 0 0 / 0.45)',
        'card-hover': '0 0.5px 0 rgb(255 255 255 / 0.9) inset, 0 4px 10px -2px rgb(15 23 42 / 0.08), 0 16px 32px -10px rgb(15 23 42 / 0.16)',
        'card-hover-dark': '0 1px 0 rgb(255 255 255 / 0.08) inset, 0 4px 12px -2px rgb(0 0 0 / 0.4), 0 24px 48px -12px rgb(0 0 0 / 0.6)',
        raised: '0 1px 0 rgb(255 255 255 / 0.6) inset, 0 -6px 12px -6px rgb(15 23 42 / 0.08) inset, 0 6px 14px -4px rgb(15 23 42 / 0.18)',
        pressed: '0 2px 6px rgb(15 23 42 / 0.15) inset',
        'glow-brand': '0 0 0 1px rgb(99 102 241 / 0.2), 0 6px 16px -4px rgb(99 102 241 / 0.45), 0 2px 4px -1px rgb(99 102 241 / 0.3)',
        popover: '0 8px 30px -6px rgb(15 23 42 / 0.18), 0 2px 10px -2px rgb(15 23 42 / 0.1), 0 0 0 1px rgb(15 23 42 / 0.04)',
        'popover-dark': '0 20px 44px -10px rgb(0 0 0 / 0.6), 0 4px 14px -4px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.06)',
        float: '0 20px 44px -14px rgb(15 23 42 / 0.22), 0 4px 12px -4px rgb(15 23 42 / 0.1)',
        'float-dark': '0 24px 56px -14px rgb(0 0 0 / 0.65), 0 6px 16px -4px rgb(0 0 0 / 0.5)',
      },
      borderRadius: {
        xl: '0.85rem',
        '2xl': '1.15rem',
        '3xl': '1.5rem',
      },
      backgroundImage: {
        mesh: 'radial-gradient(at 15% 0%, rgb(99 102 241 / 0.16) 0px, transparent 50%), radial-gradient(at 85% 10%, rgb(168 85 247 / 0.14) 0px, transparent 50%), radial-gradient(at 0% 60%, rgb(56 189 248 / 0.12) 0px, transparent 45%), radial-gradient(at 90% 90%, rgb(99 102 241 / 0.1) 0px, transparent 50%)',
        'mesh-dark': 'radial-gradient(at 15% 0%, rgb(99 102 241 / 0.22) 0px, transparent 50%), radial-gradient(at 85% 10%, rgb(168 85 247 / 0.18) 0px, transparent 50%), radial-gradient(at 0% 60%, rgb(56 189 248 / 0.14) 0px, transparent 45%), radial-gradient(at 90% 90%, rgb(99 102 241 / 0.14) 0px, transparent 50%)',
        'gloss-brand': 'linear-gradient(180deg, rgb(255 255 255 / 0.22) 0%, rgb(255 255 255 / 0) 55%)',
      },
      keyframes: {
        popIn: {
          '0%': { opacity: 0, transform: 'scale(0.96) translateY(4px)' },
          '100%': { opacity: 1, transform: 'scale(1) translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: 0, transform: 'translateY(8px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        floaty: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'pop-in': 'popIn 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        floaty: 'floaty 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
