import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Dummy values so importing src/lib/supabase.ts (which validates env at
    // module load) doesn't crash — unit tests only exercise pure functions
    // and never touch the network.
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_KEY: "test-service-key",
      INGEST_API_KEY: "test-ingest-key",
    },
  },
});
