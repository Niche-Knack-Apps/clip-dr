/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'waveform': {
          'bg': '#1a1a2e',
          'wave': '#00d4ff',
          'selection': 'rgba(0, 212, 255, 0.3)',
          'playhead': '#ff3366',
          'clip': '#00ff88',
          'muted': '#666666',
        },
        'track': {
          'bg': '#0f0f1a',
          'active': '#1a1a2e',
          'hover': '#252540',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};
