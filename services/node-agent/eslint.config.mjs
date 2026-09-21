import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: ["node_modules", "build", "dist", "scripts", "amnezia-client"],
  },
  {
    rules: {
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
