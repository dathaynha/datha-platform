import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/services/**/*.ts",
        "src/nats/consumer.ts",
        "src/nats/dlq-consumer.ts",
      ],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
