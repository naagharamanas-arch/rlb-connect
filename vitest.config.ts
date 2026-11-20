import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@app-messages": new URL("./messages/en.json", import.meta.url).pathname,
      // `import "server-only"` is resolved by Next's own compiler alias in builds
      // (it errors if a client bundle reaches it). Unit tests run in plain Node,
      // where the package is not installed, so point it at an empty module.
      "server-only": new URL("./src/lib/test-utils/server-only-stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
