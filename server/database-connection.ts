import type { PoolConfig } from "pg";
import { checkServerIdentity } from "node:tls";

type Environment = Readonly<Record<string, string | undefined>>;
const invalid = (): never => { throw new Error("Database connection policy rejected the configuration"); };

/**
 * Do not forward connectionString: pg parses it after explicit options, allowing
 * URL SSL options to replace an otherwise strict TLS object.
 * This function never includes credentials or the URL in an error.
 */
export function databaseConnection(env: Environment = process.env): PoolConfig {
  let host = env.PGHOST, port = env.PGPORT || "5432";
  let user = env.PGUSER, password = env.PGPASSWORD, database = env.PGDATABASE;
  let mode: string | undefined;
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) invalid();
      for (const key of Array.from(url.searchParams.keys())) {
        if (key !== "sslmode" || url.searchParams.getAll(key).length !== 1) invalid();
      }
      host = url.hostname.replace(/^\[|\]$/g, "");
      port = url.port || "5432";
      user = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
      database = decodeURIComponent(url.pathname.slice(1));
      mode = url.searchParams.get("sslmode") ?? undefined;
    } catch { invalid(); }
  }
  if (!host || !user || !database || !/^\d+$/.test(port) ||
      Number(port) < 1 || Number(port) > 65535) return invalid();
  if (env.NODE_ENV === "production" && host.startsWith("/")) invalid();
  const local = env.NODE_ENV !== "production" &&
    ((host === "helium" && port === "5432" && !!env.REPL_ID) || host.startsWith("/"));
  // Only the identified Replit Development endpoint or a local Unix socket may
  // opt out. Loopback/private IPs and other DNS names are NOT automatic exceptions.
  const permitted = local ? ["disable", "require", "verify-full"] : ["require", "verify-full"];
  if ([mode, env.PGSSLMODE].some(value => value !== undefined && !permitted.includes(value))) invalid();
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || env.PGSSLROOTCERT ||
      env.PGSSLCERT || env.PGSSLKEY || env.PGSERVICE || env.PGSERVICEFILE) invalid();
  const ca = env.DATABASE_CA_CERT;
  if (ca && (!ca.includes("-----BEGIN CERTIFICATE-----") ||
      !ca.includes("-----END CERTIFICATE-----"))) invalid();
  if (local && ([mode, env.PGSSLMODE].some(x => x && x !== "disable") || ca)) invalid();
  return {
    host, port: Number(port), user, password, database,
    connectionTimeoutMillis: 10000,
    ssl: local ? false : {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(ca ? { ca } : {}),
      // Bind identity to the resolved configured host, not an alternate SNI name.
      checkServerIdentity: (_name, cert) => checkServerIdentity(host!, cert),
    },
  };
}
