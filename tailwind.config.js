/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'must': '#E74C3C',
        'should': '#F39C12',
        'nice': '#3498DB',
        'complete': '#27AE60',
      },
    },
  },
  plugins: [],
};
