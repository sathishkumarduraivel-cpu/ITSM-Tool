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
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 2px 10px -2px rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 8px 24px -8px rgb(15 23 42 / 0.10)',
        'glow-brand': '0 0 0 1px rgb(99 102 241 / 0.15), 0 4px 20px -4px rgb(99 102 241 / 0.35)',
        popover: '0 8px 30px -6px rgb(15 23 42 / 0.16), 0 2px 8px -2px rgb(15 23 42 / 0.08)',
      },
      borderRadius: {
        xl: '0.85rem',
        '2xl': '1.1rem',
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
      },
      animation: {
        'pop-in': 'popIn 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
