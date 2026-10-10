import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import { databaseConnection } from "./database-connection";

export const pool = new Pool(databaseConnection());

export const db = drizzle(pool, { schema });
