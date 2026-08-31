import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const { client, db } = createDatabase(databaseUrl);
try {
  await migrate(db, { migrationsFolder: "./migrations" });
} finally {
  await client.end();
}
