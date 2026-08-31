import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export const createDatabase = (databaseUrl: string) => {
  const client = postgres(databaseUrl, { max: 10, prepare: false });
  return {
    client,
    db: drizzle(client, { schema }),
  };
};

export type Database = ReturnType<typeof createDatabase>["db"];
