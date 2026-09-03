import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror tsconfig's `"@/*": ["./*"]` so files that import "@/lib/..." resolve
// under vitest exactly as they do under Next.
const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": webRoot } },
  test: { environment: "node" },
});
