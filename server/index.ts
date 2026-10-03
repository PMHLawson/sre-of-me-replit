import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { storage } from "./storage";
import { runStartupRetention } from "./startup-retention";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// .250 #2 Content Security Policy + standard security headers.
// CSP is enabled in production only — Vite's dev server requires inline
// scripts and HMR websocket connections that a strict CSP would block.
// In production the bundled assets are emitted as external files and the
// only off-origin resources are Google Fonts (preconnect + stylesheet).
const isProduction = process.env.NODE_ENV === "production";
app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
            "img-src": ["'self'", "data:", "https:"],
            "connect-src": ["'self'"],
            "frame-ancestors": ["'self'"],
            "object-src": ["'none'"],
            "base-uri": ["'self'"],
            "form-action": ["'self'"],
          },
        }
      : false,
    // Replit publicly hosts the app behind a reverse proxy; HSTS is owned
    // by the edge, but enabling at the app level is a defense-in-depth win
    // for production traffic.
    strictTransportSecurity: isProduction
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
    // Cross-Origin-Embedder-Policy interferes with third-party fonts /
    // images we already permit via CSP, so leave it off.
    crossOriginEmbedderPolicy: false,
  }),
);

// .250 #6 Rate limiting. Applied in production only so the dev loop is
// not throttled while iterating. Two zones: a generous /api/* limiter to
// blunt scraping/abuse, and a tight /api/login limiter to slow credential-
// stuffing-style hits against the OIDC entrypoint.
if (isProduction) {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Too many requests, please slow down." },
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Too many login attempts, please try again later." },
  });
  app.use("/api/login", loginLimiter);
  app.use("/api/callback", loginLimiter);
  app.use("/api", apiLimiter);
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// .250 #13 Security-relevant logging without PII exposure. We log only
// the request envelope (method, path, status, duration) for /api/*. The
// previous implementation appended the JSON response body, which leaked
// session notes, settings, deviation reasons, and user profile fields
// into stdout. Error context for failures lives in the global error
// handler (server-side console.error) where the raw error remains
// available for debugging without surfacing user data in access logs.
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  // Replit Auth must be set up before all other routes
  await setupAuth(app);
  registerAuthRoutes(app);

  await registerRoutes(httpServer, app);

  // .250 #12 Error response sanitization. 4xx errors are intentionally
  // surfaced to the client (validation messages, 401/404, etc.); 5xx
  // errors are logged in full server-side but reduced to a generic
  // string for the client so internals (DB messages, stack traces,
  // file paths) never leak. The route handlers in server/routes.ts
  // already shape their own 5xx responses; this is the safety net.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    const safeMessage =
      status >= 500
        ? "Internal Server Error"
        : err.message || "Request failed";

    return res.status(status).json({ message: safeMessage });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      // Preserve activity by default. Only the exact documented opt-in permits
      // the existing fire-and-forget 42-day purge; keep it off during recovery.
      void runStartupRetention({
        optIn: process.env.SESSION_RETENTION_PURGE_ENABLED,
        storage,
        log,
      });
    },
  );
})();
