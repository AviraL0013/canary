import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000, // 60s — includes docker service warm-up
    hookTimeout: 30_000,
  },
});
