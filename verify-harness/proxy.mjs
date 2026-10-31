/**
 * /rest/v1 prefix proxy for the local verification harness.
 *
 * @supabase/supabase-js always requests `${SUPABASE_URL}/rest/v1/...`.
 * PostgREST serves at the root, so this tiny HTTP proxy maps
 *   http://127.0.0.1:5435/rest/v1/<path>  ->  http://127.0.0.1:5434/<path>
 * and refuses everything else — exactly the shape Supabase itself exposes.
 */
import http from "node:http";

const PROXY_PORT = Number(process.env.HARNESS_PROXY_PORT ?? 5435);
const POSTGREST_PORT = Number(process.env.HARNESS_POSTGREST_PORT ?? 5434);

export function startPrefixProxy() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PROXY_PORT}`);

    // Local control endpoint used by stop.mjs (loopback only).
    if (req.method === "DELETE" && url.pathname === "/__harness_shutdown__") {
      res.writeHead(204);
      res.end();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
      return;
    }

    if (!url.pathname.startsWith("/rest/v1/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }

    const targetPath = url.pathname.replace(/^\/rest\/v1/, "") + url.search;
    const proxyReq = http.request(
      {
        host: "127.0.0.1",
        port: POSTGREST_PORT,
        method: req.method,
        path: targetPath,
        headers: { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "PostgREST unreachable", detail: String(err.message) }));
    });

    req.pipe(proxyReq, { end: true });
  });

  return new Promise((resolve) => {
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}

// When run directly, keep the proxy alive standalone.
if (process.argv[1]?.endsWith("proxy.mjs")) {
  startPrefixProxy().then(() => {
    console.log(`[harness] rest/v1 prefix proxy listening on 127.0.0.1:${PROXY_PORT}`);
  });
}
