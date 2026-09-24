/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        studio: {
          950: "#0b0d12",
          900: "#11141c",
          850: "#151926",
          800: "#1b2030",
          700: "#252b3d",
          600: "#39415a",
          400: "#8b93ad",
          200: "#c9cee0",
          100: "#eef1f8",
        },
        accent: {
          DEFAULT: "#7c5cff",
          soft: "#a48bff",
          warm: "#ff8f5c",
          mint: "#4fd1a5",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
