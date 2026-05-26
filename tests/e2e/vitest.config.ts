import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {

    testTimeout:
      60_000,

    hookTimeout:
      30_000,

    globalSetup:
      "./src/setup/globalSetup.ts",

    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "src/performance/**/*.perf.test.ts"
    ],
  },
});