import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// HTTP session storage table — used by connect-pg-simple / passport.
// Named http_sessions to avoid collision with the cultivation sessions table.
// (IMPORTANT) Do not drop this table — Replit Auth depends on it.
export const httpSessions = pgTable(
  "http_sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_http_session_expire").on(table.expire)]
);

// User table — populated by Replit OIDC on every login.
// (IMPORTANT) Do not drop this table — Replit Auth depends on it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
