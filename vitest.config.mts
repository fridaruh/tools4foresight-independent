import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Solo para los tests del onboarding (por ahora). El resto del QA de este repo
 * corre contra la base real con `npm run qa`; esto es lo contrario: componentes
 * en jsdom, sin red y sin Postgres.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
