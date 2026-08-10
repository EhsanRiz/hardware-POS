/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
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
