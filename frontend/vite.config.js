import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    hmr: {
      host: "127.0.0.1",
      port: 5174,
    },
    watch: {
      ignored: ["**/package.json", "**/bun.lock", "**/dist/**", "**/.venv/**"],
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
    exclude: ["lucide-react"],
  },
});
