import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// AsterMux keeps unit and integration tests beside their runtime domains.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Ensure .js extensions resolve for ESM
      "#test": resolve(__dirname, "src"),
    },
  },
});
