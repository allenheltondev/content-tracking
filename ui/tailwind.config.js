/** @type {import('tailwindcss').Config} */
// Brand palette, fonts, and shape tokens come from the shared
// @readysetcloud/ui preset — the single source of truth for the Ready,
// Set, Cloud design system. Don't redefine colors/fonts here; extend the
// preset only with app-specific additions.
export default {
  presets: [require('@readysetcloud/ui/tailwind-preset')],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // REQUIRED — the package's components use token utility classes, so
    // Tailwind must scan the shipped dist to emit them.
    './node_modules/@readysetcloud/ui/dist/**/*.js',
  ],
};
