/** @type {import('tailwindcss').Config} */
// Color palette and shape tokens lifted from newsletter-service's
// dashboard-ui so both UIs sit on the same theming substrate. Only the
// light-mode token set is wired up here; dark mode lands later.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--background) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        'muted-foreground': 'rgb(var(--muted-foreground) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
        primary: scale('primary'),
        secondary: scale('secondary'),
        success: scale('success'),
        warning: scale('warning'),
        error: scale('error'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'Monaco', 'monospace'],
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
      },
      boxShadow: {
        soft: '0 2px 15px -3px rgba(0, 0, 0, 0.07), 0 10px 20px -2px rgba(0, 0, 0, 0.04)',
        medium: '0 4px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      },
    },
  },
  plugins: [],
};

function scale(name) {
  const scale = {};
  for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
    scale[step] = `rgb(var(--${name}-${step}) / <alpha-value>)`;
  }
  return scale;
}
