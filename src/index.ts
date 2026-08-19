import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import auth from "./routes/auth";
import events from "./routes/events";
import shoppers from "./routes/shoppers";

const INGEST_API_KEY = process.env.INGEST_API_KEY;

if (!INGEST_API_KEY) {
  throw new Error(
    "Missing INGEST_API_KEY environment variable. " +
      "Copy .env.example to .env and set a long random secret — the extension " +
      "sends it in the x-fohlioo-key header on event and shopper requests."
  );
}

const app = new Hono();

app.use("*", logger());

// Chrome extensions send requests with an origin like
// "chrome-extension://<extension-id>". Once you have your published
// extension ID, replace "*" below with that exact origin to lock this down.
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "x-fohlioo-key", "Authorization"],
  })
);

const INGEST_KEY_PATHS = ["/api/v1/events", "/api/v1/shoppers"];

// Shared-secret on ingest + shopper reads. Auth exchange is exempt — the
// one-time code is the credential, and the extension does not send the key.
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  const needsIngestKey = INGEST_KEY_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
  if (needsIngestKey && c.req.header("x-fohlioo-key") !== INGEST_API_KEY) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/", (c) => c.json({ service: "fohlioo-api", status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));

app.route("/api/v1/auth", auth);
app.route("/api/v1/events", events);
app.route("/api/v1/shoppers", shoppers);

const port = Number(process.env.PORT) || 8080;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`fohlioo-api listening on http://localhost:${info.port}`);
});
