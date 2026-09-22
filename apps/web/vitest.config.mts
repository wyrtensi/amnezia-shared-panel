import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror tsconfig's `"@/*": ["./*"]` so files that import "@/lib/..." resolve
// under vitest exactly as they do under Next.
const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": webRoot } },
  // tsconfig sets `jsx: "preserve"` because Next does the transform in the app.
  // Vitest has no Next in front of it, so it must compile JSX itself or any
  // .tsx a test imports fails to parse. Vite 8 transforms with oxc, not esbuild.
  oxc: { jsx: { runtime: "automatic" } },
  test: { environment: "node" },
});
