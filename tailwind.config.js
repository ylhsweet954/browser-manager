/** @type {import('tailwindcss').Config} */
export default {
  content: ['./entrypoints/**/*.{html,ts}', './lib/**/*.{ts,js}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Georgia', 'Times New Roman', 'Times', 'serif'],
        sans: ['Arial', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        bm: {
          page: 'var(--bm-page)',
          card: 'var(--bm-card)',
          elevated: 'var(--bm-elevated)',
          muted: 'var(--bm-muted)',
          fg: 'var(--bm-fg)',
          'fg-muted': 'var(--bm-fg-muted)',
          'fg-subtle': 'var(--bm-fg-subtle)',
          border: 'var(--bm-border)',
          'border-strong': 'var(--bm-border-strong)',
          accent: 'var(--bm-accent)',
          'accent-fg': 'var(--bm-accent-fg)',
          coral: 'var(--bm-coral)',
          hover: 'var(--bm-hover)',
          'hover-strong': 'var(--bm-hover-strong)',
          backdrop: 'var(--bm-backdrop)',
        },
      },
      boxShadow: {
        whisper: 'var(--bm-shadow-whisper)',
      },
    },
  },
  plugins: [],
}
