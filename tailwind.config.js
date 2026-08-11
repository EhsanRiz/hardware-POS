/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // Classical design system (design_handoff_innovapos). These mirror the CSS
      // custom properties in src/styles/tokens.css — that file is the source of
      // truth; this makes them reachable as Tailwind utilities.
      colors: {
        paper: "var(--color-bg)",
        surface: "var(--color-surface)",
        ink: "var(--color-text)",
        colophon: "var(--color-colophon)",
        gold: {
          DEFAULT: "var(--color-accent)",
          100: "var(--color-accent-100)",
          400: "var(--color-accent-400)",
          700: "var(--color-accent-700)",
        },
        muted: {
          100: "var(--color-neutral-100)",
          200: "var(--color-neutral-200)",
          300: "var(--color-neutral-300)",
          400: "var(--color-neutral-400)",
          700: "var(--color-neutral-700)",
          800: "var(--color-neutral-800)",
          900: "var(--color-neutral-900)",
        },
      },
      fontFamily: {
        heading: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        body: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderColor: {
        hairline: "var(--divider)",
        row: "var(--divider-row)",
      },
      borderRadius: { sm: "2px", DEFAULT: "4px", lg: "7px" },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      spacing: {
        s1: "4.6px", s2: "9.2px", s3: "13.8px",
        s4: "18.4px", s6: "27.6px", s8: "36.8px",
      },
      // Palette pulled directly from the 4D Climate Solutions logo.
      colors: {
        brand: {
          DEFAULT: "#189c3a", // "4D" leaf green (primary actions)
          dark: "#0f7a2c",
          light: "#e9f6ec",
        },
        accent: {
          DEFAULT: "#8dc63f", // lime green (icon centre bar)
          dark: "#6fa32f",
        },
        info: "#29abe2", // sky blue (icon left bar)
        taupe: {
          DEFAULT: "#7a6a5d", // tagline brown (muted text/borders)
          light: "#9a8478",
        },
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.05)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out both",
        "scale-in": "scale-in 0.18s ease-out both",
        "slide-up": "slide-up 0.25s ease-out both",
        pop: "pop 0.25s ease-out",
      },
    },
  },
  plugins: [],
};
