// Model Context Protocol (MCP) server entrypoint for Freefield.
//   npm run mcp                       stdio transport (Antigravity, Gemini CLI, Claude Desktop/Code, Cursor)
//   npm run mcp -- --http [port]      standalone Streamable HTTP MCP server on /mcp (default port: 3001)
// Note: `npm run serve` (server/server.ts) also mounts the HTTP MCP endpoint at /mcp alongside the Web UI.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { McpServer } from "./mcp-core.ts";

const args = process.argv.slice(2);
const httpIdx = args.indexOf("--http");

if (httpIdx < 0) {
  // In stdio mode, stdout belongs exclusively to JSON-RPC frames; redirect console.log to stderr.
  console.log = (...a: unknown[]) => console.error(...a);
}

const mcp = new McpServer();

if (httpIdx >= 0) {
  const portArg = args[httpIdx + 1];
  const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : Number(process.env.MCP_PORT ?? 3001);
  const host = process.env.FREEFIELD_HOST || "127.0.0.1";
  const token = process.env.FREEFIELD_MCP_TOKEN || process.env.FREEFIELD_PASSCODE || "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization, mcp-session-id, accept");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (token) {
      const auth = req.headers.authorization ?? "";
      const key = url.searchParams.get("key") ?? "";
      if (auth !== `Bearer ${token}` && key !== token) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "unauthorized: provide Authorization: Bearer <token> or ?key=<token>" }));
      }
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, server: "freefield-mcp", apps: mcp.apps.length }));
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    if (req.method === "GET") {
      if ((req.headers.accept ?? "").includes("text/event-stream")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": freefield-mcp stream ready\n\n");
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => clearInterval(keepAlive));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        name: "freefield-mcp",
        version: "0.1.0",
        transport: "streamable-http",
        endpoint: "/mcp",
        apps: mcp.apps.length,
      }));
    }
    if (req.method === "DELETE") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      }
      const answer = await mcp.handlePayload(payload);
      if (answer === null) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(answer));
    }
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  });

  server.listen(port, host, () => {
    console.error(`freefield-mcp HTTP listening on http://${host}:${port}/mcp (${mcp.apps.length} apps)`);
  });
} else {
  // Stdio transport: newline-delimited JSON-RPC 2.0 on stdin → stdout
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed || /^content-length:/i.test(trimmed)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n",
      );
      return;
    }
    const answer = await mcp.handlePayload(payload);
    if (answer !== null) {
      process.stdout.write(JSON.stringify(answer) + "\n");
    }
  });
}
