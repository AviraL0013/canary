import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 300_000,     // 5 minutes per test
    hookTimeout: 120_000,     // 2 minutes for setup/teardown
    globalSetup: "./src/setup/globalSetup.ts",
    include: ["src/performance/**/*.perf.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },  // Sequential execution for benchmarks
    },
    fileParallelism: false,   // No parallel file execution
  },
});
