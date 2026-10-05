import { pathToFileURL } from "node:url";
import { readAdoptionConfig, mountDevelopmentAdoption, prepareAdoptionServices, adoptionPath } from "../server/services/development-policy-adoption";

/** Temporary replacement listener during an independently verified quiet interval.
 * Never imported by server/index.ts, routes.ts, application startup or deployment.
 * The operator must preserve a fresh encrypted backup and exclude the original
 * application/writers before launching. Configuration expires within 15 minutes.
 */
export async function runPolicyAdoption(env = process.env) {
  const config = readAdoptionConfig(env);
  if (!config.enabled || !env.SESSION_SECRET || !env.REPL_ID || !env.DATABASE_URL) throw Error("Service unavailable");
  const port = env.PORT ?? "5000";
  if (port !== "5000") throw Error("Service unavailable");
  // All runtime/auth/database imports are deliberately after the disabled gate.
  const [{ default: express }, { createServer }, auth, { pool }] = await Promise.all([
    import("express"), import("node:http"), import("../server/replit_integrations/auth"), import("../server/db")]);
  const app = express();
  // Refuse foreign hosts before the existing OAuth handlers can select a strategy.
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    if (Date.now() >= config.expiresAt! || req.protocol !== "https" || req.hostname !== new URL(config.origin!).hostname)
      return res.status(503).type("text").send("Service unavailable");
    next();
  });
  app.use(express.json({ limit: "1kb" })); app.use(express.urlencoded({ extended: false, limit: "1kb" }));
  await auth.setupAuth(app);
  mountDevelopmentAdoption(app, { config, authenticate: auth.isAuthenticated,
    getServices: () => prepareAdoptionServices(pool, config) });
  app.get("/", (_req, res) => res.redirect(adoptionPath));
  app.use((_error: unknown, _req: unknown, res: any, _next: unknown) => res.status(400).type("text").send("Invalid request"));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(5000, "0.0.0.0", () => { server.removeListener("error", reject); resolve(); });
  });
  const timer = setTimeout(() => {
    server.closeAllConnections(); server.close(); void pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }, Math.max(1, config.expiresAt! - Date.now()));
  timer.unref();
  return { server, timer };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPolicyAdoption().then(() => process.stdout.write("Development maintenance listener ready\n"))
    .catch(() => { process.stderr.write("Service unavailable\n"); process.exitCode = 1; });
}
