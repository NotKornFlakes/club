// Test-only bindings added in vitest.config.js.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

// Files imported as text in tests (Vite's "?raw").
declare module "*?raw" {
  const text: string;
  export default text;
}
