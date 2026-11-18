import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The PostgreSQL integration suites share one test database and some of
    // them start by clearing whole tables (`delete from nodes`), so two of them
    // running at once would delete each other's rows or trip the RESTRICT
    // foreign keys of bridge routes. Run the test files one after another.
    fileParallelism: false,
  },
});
