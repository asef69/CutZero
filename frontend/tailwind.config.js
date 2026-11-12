/** @type {import('tailwindcss').Config} */
export default {
  // Relative to this file, so builds started from the repo root still find the sources.
  content: { relative: true, files: ["./index.html", "./src/**/*.{ts,tsx}"] },
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070b10",
          900: "#0b1118",
          850: "#0f1720",
          800: "#141e29",
          700: "#1d2a37",
          600: "#2b3a4a",
          500: "#4a5c6e",
          400: "#71849a",
          300: "#9aabbc",
          200: "#c4d0db",
          100: "#e6ecf2",
        },
        waste: { DEFAULT: "#f0506e", dim: "#b0344f" },
        saved: { DEFAULT: "#2fd6a0", dim: "#1b9c74" },
        signal: "#f5b83d",
      },
      fontFamily: {
        sans: ['"Inter Variable"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
