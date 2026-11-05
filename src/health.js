// Tiny HTTP status endpoint. Tinfoil Containers route traffic to an HTTP port
// (the "shim"), and it doubles as a container healthcheck. It reports only
// non-sensitive status, since it is publicly reachable.
//
//   /, /health  bot status (200 when syncing, 503 otherwise)
//   /diag       outbound connectivity check (DNS + TLS) to the hosts the bot
//               needs; results are cached for a minute.

import http from "node:http";
import tls from "node:tls";
import dns from "node:dns/promises";
import { LogService } from "matrix-bot-sdk";

const DIAG_TTL_MS = 60 * 1000;

export function startHealthServer(port, getStatus, getDiagHosts = () => []) {
    let diagCache = null;

    const server = http.createServer(async (req, res) => {
        const send = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(obj, null, 2));
        };
        try {
            if (req.url?.startsWith("/diag")) {
                if (!diagCache || Date.now() - diagCache.at > DIAG_TTL_MS) {
                    diagCache = { at: Date.now(), promise: runDiagnostics(getDiagHosts()) };
                }
                return send(200, { checkedAt: new Date(diagCache.at).toISOString(), results: await diagCache.promise });
            }
            const status = getStatus();
            send(status.ok ? 200 : 503, status);
        } catch (err) {
            send(500, { error: String(err?.message || err) });
        }
    });
    server.listen(port, "0.0.0.0", () => LogService.info("melong", `Status endpoint listening on 0.0.0.0:${port}`));
    return server;
}

async function runDiagnostics(hosts) {
    return Promise.all([...new Set(hosts)].map(checkHost));
}

// Resolves a host and opens a TLS connection to it on port 443.
async function checkHost(host) {
    const result = { host };
    try {
        result.addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
        return { ...result, ok: false, stage: "dns", error: err.code || err.message };
    }
    const start = Date.now();
    return new Promise((resolve) => {
        const socket = tls.connect({ host, port: 443, servername: host, timeout: 8000 });
        const done = (extra) => {
            socket.destroy();
            resolve({ ...result, ms: Date.now() - start, ...extra });
        };
        socket.once("secureConnect", () => done({ ok: true, stage: "tls" }));
        socket.once("timeout", () => done({ ok: false, stage: "connect", error: "timed out after 8s" }));
        socket.once("error", (err) => done({ ok: false, stage: "connect", error: err.code || err.message }));
    });
}
