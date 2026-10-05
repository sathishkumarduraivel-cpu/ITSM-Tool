/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Geist declared first (in case it's installed locally); falls back to
        // the closest high-quality system faces rather than a webfont CDN,
        // which the app can't reach reliably in every deployment.
        sans: ['Geist Sans', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable"', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'],
        display: ['Geist Sans', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable"', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', '"Cascadia Code"', '"SF Mono"', 'Consolas', 'monospace'],
      },
      colors: {
        // Electric teal/cyan — primary accent. #06B6D4 / #0891B2, as picked.
        brand: {
          50: '#ECFEFF',
          100: '#CFFAFE',
          200: '#A5F3FC',
          300: '#67E8F9',
          400: '#22D3EE',
          500: '#06B6D4',
          600: '#0891B2',
          700: '#0E7490',
          800: '#155E75',
          900: '#164E63',
        },
        // Azure blue — secondary accent, used for AI/"live" signals and glows.
        // Pairs with the teal brand color for brand->neon gradients/sweeps
        // instead of repeating the same hue. Kept as its own token (not
        // Tailwind's built-in `sky`) so it never collides with an incidental
        // utility used elsewhere.
        neon: {
          50: '#EFF8FF',
          100: '#DBEEFF',
          200: '#BFE2FF',
          300: '#93CFFF',
          400: '#5EB3FF',
          500: '#2F97FF',
          600: '#0B74E0',
          700: '#0A5CB3',
          800: '#0C4A8C',
          900: '#0F3D70',
        },
        obsidian: {
          DEFAULT: '#07080D',
          elevated: '#12141F',
          surface: '#181B2E',
        },
      },
      boxShadow: {
        soft: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 6px -1px rgb(0 0 0 / 0.06)',
        // Layered "3D" elevation — several stacked shadows at increasing blur/spread
        // read as real depth instead of a single flat drop-shadow. The `inset`
        // pass at 0 1px is a glass edge-highlight: light catching the top rim.
        card: '0 1px 0 rgb(255 255 255 / 0.8) inset, 0 1px 1px rgb(15 23 42 / 0.03), 0 2px 6px -1px rgb(15 23 42 / 0.05), 0 8px 20px -6px rgb(15 23 42 / 0.08)',
        'card-dark': '0 1px 0 rgb(255 255 255 / 0.07) inset, 0 10px 20px -12px rgb(0 0 0 / 0.55), 0 30px 60px -24px rgb(0 0 0 / 0.65)',
        'card-hover': '0 1px 0 rgb(255 255 255 / 0.9) inset, 0 4px 10px -2px rgb(15 23 42 / 0.08), 0 16px 32px -10px rgb(15 23 42 / 0.16)',
        'card-hover-dark': '0 1px 0 rgb(255 255 255 / 0.1) inset, 0 14px 28px -10px rgb(0 0 0 / 0.6), 0 36px 64px -16px rgb(0 0 0 / 0.7)',
        raised: '0 1px 0 rgb(255 255 255 / 0.6) inset, 0 -6px 12px -6px rgb(15 23 42 / 0.08) inset, 0 6px 14px -4px rgb(15 23 42 / 0.18)',
        pressed: '0 2px 6px rgb(15 23 42 / 0.15) inset',
        'glow-brand': '0 0 0 1px rgb(6 182 212 / 0.3), 0 6px 16px -4px rgb(6 182 212 / 0.55), 0 2px 4px -1px rgb(6 182 212 / 0.35)',
        'glow-neon': '0 0 0 1px rgb(47 151 255 / 0.3), 0 0 24px -6px rgb(47 151 255 / 0.5)',
        popover: '0 8px 30px -6px rgb(15 23 42 / 0.18), 0 2px 10px -2px rgb(15 23 42 / 0.1), 0 0 0 1px rgb(15 23 42 / 0.04)',
        'popover-dark': '0 1px 0 rgb(255 255 255 / 0.08) inset, 0 24px 56px -14px rgb(0 0 0 / 0.7), 0 6px 16px -4px rgb(0 0 0 / 0.55)',
        float: '0 20px 44px -14px rgb(15 23 42 / 0.22), 0 4px 12px -4px rgb(15 23 42 / 0.1)',
        'float-dark': '0 1px 0 rgb(255 255 255 / 0.06) inset, 0 30px 64px -16px rgb(0 0 0 / 0.7), 0 8px 20px -6px rgb(0 0 0 / 0.55)',
      },
      borderRadius: {
        xl: '0.85rem',
        '2xl': '1.15rem',
        '3xl': '1.5rem',
      },
      backgroundImage: {
        mesh: 'radial-gradient(at 15% 0%, rgb(6 182 212 / 0.14) 0px, transparent 50%), radial-gradient(at 85% 10%, rgb(47 151 255 / 0.1) 0px, transparent 50%), radial-gradient(at 0% 60%, rgb(6 182 212 / 0.08) 0px, transparent 45%), radial-gradient(at 90% 90%, rgb(47 151 255 / 0.08) 0px, transparent 50%)',
        'mesh-dark': 'radial-gradient(at 12% 8%, rgb(6 182 212 / 0.16) 0px, transparent 60%), radial-gradient(at 88% 92%, rgb(47 151 255 / 0.14) 0px, transparent 60%)',
        'gloss-brand': 'linear-gradient(180deg, rgb(255 255 255 / 0.22) 0%, rgb(255 255 255 / 0) 55%)',
        grain: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
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
        driftGlow: {
          '0%': { backgroundPosition: '0% 0%, 0% 0%' },
          '100%': { backgroundPosition: '3% 4%, -3% -4%' },
        },
        rotateAngle: {
          to: { '--angle': '360deg' },
        },
      },
      animation: {
        'pop-in': 'popIn 0.16s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        floaty: 'floaty 6s ease-in-out infinite',
        'drift-glow': 'driftGlow 26s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
};
