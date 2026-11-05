// Tiny HTTP status endpoint. Tinfoil Containers route traffic to an HTTP port
// (the "shim"), and it doubles as a container healthcheck. It reports only
// non-sensitive status, since it is publicly reachable.

import http from "node:http";
import { LogService } from "matrix-bot-sdk";

export function startHealthServer(port, getStatus) {
    const server = http.createServer((req, res) => {
        const status = getStatus();
        res.writeHead(status.ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(status));
    });
    server.listen(port, "0.0.0.0", () => LogService.info("melong", `Status endpoint listening on 0.0.0.0:${port}`));
    return server;
}
