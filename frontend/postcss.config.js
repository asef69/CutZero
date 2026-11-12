import { fileURLToPath } from "node:url";

export default {
  plugins: {
    // Explicit path, so the studio also builds when Vite is started from the repo root.
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
    autoprefixer: {},
  },
};
