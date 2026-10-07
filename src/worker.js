// HTTP front door. Static files in ./public are served automatically by
// Cloudflare; only /api/* requests reach this code.

import { readConfig, cleanName, extOf } from "./config.js";
export { Vault } from "./vault.js";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const MESSAGES = {
  BAD_REQUEST: "BAD REQUEST",
  BAD_PIN: "PIN MUST BE 4 DIGITS",
  NO_FILE: "NO FILE RECEIVED",
  TOO_LARGE: "FILE TOO LARGE",
  BAD_TYPE: "FILE TYPE NOT ALLOWED",
  NOT_FOUND: "PIN NOT FOUND OR EXPIRED",
  LOCKED: "TOO MANY WRONG PINS FROM THIS NETWORK",
  LOCKED_GLOBAL: "TOO MANY WRONG PINS - LOOKUPS PAUSED",
  UPLOAD_LIMIT: "TOO MANY UPLOADS FROM THIS NETWORK",
  FULL: "STORAGE FULL - TRY AGAIN LATER",
  CORRUPT: "FILE DAMAGED - PLEASE RESEND",
  METHOD: "METHOD NOT ALLOWED",
  NO_ROUTE: "UNKNOWN COMMAND",
  SERVER: "SYSTEM ERROR",
};

const STATUS = {
  BAD_REQUEST: 400, BAD_PIN: 400, NO_FILE: 400, TOO_LARGE: 413, BAD_TYPE: 415,
  NOT_FOUND: 404, LOCKED: 429, LOCKED_GLOBAL: 429, UPLOAD_LIMIT: 429,
  FULL: 507, CORRUPT: 500, METHOD: 405, NO_ROUTE: 404, SERVER: 500,
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function fail(code, details = {}) {
  const extra = details.retryAfter ? { "Retry-After": String(details.retryAfter) } : {};
  return json({ error: code, message: MESSAGES[code] ?? code, ...details }, STATUS[code] ?? 400, extra);
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function vault(env) {
  return env.VAULT.get(env.VAULT.idFromName("main"));
}

async function readPin(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  return /^\d{4}$/.test(pin) ? pin : null;
}

// Read the request body but stop as soon as it exceeds the limit.
async function readLimited(request, max) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  if (!request.body) return { bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.byteLength;
  }
  return { bytes };
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function handle(request, env, url) {
  const cfg = readConfig(env);
  const path = url.pathname;

  if (path === "/api/config") {
    if (request.method !== "GET") return fail("METHOD");
    return json({
      maxBytes: cfg.maxBytes,
      ttlOptions: cfg.ttlOptions,
      defaultTtl: cfg.defaultTtl,
      onceDefault: cfg.onceDefault,
      allowedExt: cfg.allowedExt,
    });
  }

  if (request.method !== "POST") return fail("METHOD");

  if (path === "/api/upload") {
    let rawName = request.headers.get("X-File-Name") || "";
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
      return fail("BAD_REQUEST");
    }
    const name = cleanName(rawName);
    if (cfg.allowedExt && !cfg.allowedExt.includes(extOf(name))) {
      return fail("BAD_TYPE", { allowed: cfg.allowedExt });
    }
    const body = await readLimited(request, cfg.maxBytes);
    if (body.tooLarge) return fail("TOO_LARGE", { maxBytes: cfg.maxBytes });
    if (body.bytes.byteLength === 0) return fail("NO_FILE");

    const r = await vault(env).upload({
      name,
      bytes: body.bytes.buffer,
      ttlMin: Number(request.headers.get("X-TTL-Min")),
      once: request.headers.get("X-Once") !== "0",
      ip: clientIp(request),
    });
    return r.error ? fail(r.error, r) : json(r, 201);
  }

  if (path === "/api/peek" || path === "/api/download") {
    const pin = await readPin(request);
    if (!pin) return fail("BAD_PIN");
    const v = vault(env);
    const ip = clientIp(request);

    if (path === "/api/peek") {
      const r = await v.peek({ pin, ip });
      return r.error ? fail(r.error, r) : json(r);
    }

    const r = await v.take({ pin, ip });
    if (r.error) return fail(r.error, r);
    return new Response(r.bytes, {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(r.name),
        "X-File-Once": r.once ? "1" : "0",
      },
    });
  }

  if (path === "/api/burn") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("BAD_REQUEST");
    }
    const pin = typeof body?.pin === "string" ? body.pin : "";
    const token = typeof body?.token === "string" ? body.token : "";
    if (!/^\d{4}$/.test(pin) || !token) return fail("BAD_REQUEST");
    const r = await vault(env).burn({ pin, token });
    return r.error ? fail(r.error) : json(r);
  }

  return fail("NO_ROUTE");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("404 NOT FOUND", { status: 404, headers: BASE_HEADERS });
    }
    try {
      return await handle(request, env, url);
    } catch (err) {
      console.error("pin-drop error", err?.stack || err);
      return fail("SERVER");
    }
  },
};
