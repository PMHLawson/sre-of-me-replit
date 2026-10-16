import { drizzle } from "drizzle-orm/node-postgres";
import { createDatabasePool } from "./database-pool";
import * as schema from "@shared/schema";
import { databaseConnection } from "./database-connection";

export const pool = createDatabasePool(databaseConnection());

export const db = drizzle(pool, { schema });
