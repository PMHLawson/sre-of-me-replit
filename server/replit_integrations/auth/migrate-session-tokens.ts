import { isEncryptedRefreshToken, type TokenVault } from "./token-vault";

interface DbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}
interface DbPool { connect(): Promise<DbClient> }
interface Options { after?: string; limit?: number; apply?: boolean }
const unavailable = () => new Error("Session token migration unavailable");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function plan(text: string, vault: TokenVault) {
  const root: unknown = JSON.parse(text);
  if (!record(root)) throw unavailable();
  if (root.passport == null) return { change: false, envelope: null };
  if (!record(root.passport)) throw unavailable();
  const user = root.passport.user;
  if (user == null) return { change: false, envelope: null };
  if (!record(user)) throw unavailable();
  const token = user.refresh_token;
  let envelope: string | null = null;
  if (typeof token === "string") {
    envelope = JSON.stringify(vault.encrypt(token));
  } else if (isEncryptedRefreshToken(token)) {
    const plaintext = vault.decrypt(token);
    if (token.keyId !== vault.activeKeyId) envelope = JSON.stringify(vault.encrypt(plaintext));
  } else if (token !== undefined && token !== null) {
    throw unavailable();
  }
  return { change: envelope !== null || own(user, "access_token"), envelope };
}

const selectSql = `
  SELECT sid, sess::text AS prior_sess, expire::text AS prior_expire,
         expire <= CURRENT_TIMESTAMP AS expired
  FROM public."http_sessions"
  WHERE ($1::text IS NULL OR sid COLLATE "C" > $1::text COLLATE "C")
  ORDER BY sid COLLATE "C"
  LIMIT $2
`;
const updateSql = `
  UPDATE public."http_sessions"
  SET sess = (
    CASE WHEN $4::text IS NULL THEN sess::jsonb
    ELSE jsonb_set(sess::jsonb, '{passport,user,refresh_token}', $4::jsonb, false) END
  ) #- '{passport,user,access_token}'
  WHERE sid = $1 AND sess::text = $2 AND expire::text = $3
  RETURNING sid
`;

/**
 * Internal, explicitly invoked administrative operation. Never imported by a route
 * or startup path. Defaults to read-only inventory; processes at most 100 rows.
 * Cursor values are sensitive session IDs: persist privately, never log the result.
 * All writers must use the protected store before a live apply or final inventory.
 */
export async function migrateSessionTokenBatch(pool: DbPool, vault: TokenVault, options: Options = {}) {
  let client: DbClient | undefined;
  let transaction = false;
  try {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (options.after !== undefined && (typeof options.after !== "string" ||
          options.after.length > 512 || options.after.includes("\u0000"))) ||
        (options.apply !== undefined && typeof options.apply !== "boolean") ||
        Object.keys(options).some(key => !["after", "limit", "apply"].includes(key))) throw unavailable();
    client = await pool.connect();
    await client.query(options.apply
      ? "BEGIN ISOLATION LEVEL READ COMMITTED"
      : "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const { rows } = await client.query(selectSql, [options.after ?? null, limit]);
    const counts = { scanned: rows.length, wouldChange: 0, updated: 0, conflicts: 0, unchanged: 0, expired: 0 };
    if (rows.length > limit) throw unavailable();
    for (const row of rows) {
      if (typeof row.sid !== "string" || typeof row.prior_sess !== "string" ||
          typeof row.prior_expire !== "string" || typeof row.expired !== "boolean") throw unavailable();
      if (row.expired) counts.expired++;
      const next = plan(row.prior_sess, vault);
      if (!next.change) { counts.unchanged++; continue; }
      counts.wouldChange++;
      if (!options.apply) continue;
      const result = await client.query(updateSql, [row.sid, row.prior_sess, row.prior_expire, next.envelope]);
      if (result.rowCount === 1) counts.updated++;
      else if (result.rowCount === 0) counts.conflicts++;
      else throw unavailable();
    }
    await client.query(options.apply ? "COMMIT" : "ROLLBACK");
    transaction = false;
    return {
      counts,
      privateNextCursor: rows.length === limit ? rows[rows.length - 1].sid as string : null,
    };
  } catch {
    if (transaction && client) { try { await client.query("ROLLBACK"); } catch {} }
    throw unavailable();
  } finally {
    if (client) { try { client.release(); } catch { throw unavailable(); } }
  }
}
