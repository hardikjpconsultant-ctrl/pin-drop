// The vault: a single SQLite-backed Durable Object that holds every waiting
// file. Being one object gives exact, consistent answers for PIN lookups,
// expiry and attempt counting (no "PIN not found yet" delays between regions).

import { DurableObject } from "cloudflare:workers";
import { readConfig } from "./config.js";

const CHUNK_BYTES = 1024 * 1024; // SQLite rows max out at 2 MB, so store 1 MB slices
const PIN_COOLDOWN_MS = 24 * 60 * 60 * 1000; // a used PIN isn't handed out again for 24 h

function randomPin() {
  // Unbiased 0000-9999 using rejection sampling.
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 10000) * 10000;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 10000).padStart(4, "0");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Vault extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        pin       TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        size      INTEGER NOT NULL,
        created   INTEGER NOT NULL,
        expires   INTEGER NOT NULL,
        once      INTEGER NOT NULL,
        token     TEXT NOT NULL,
        chunks    INTEGER NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chunks (
        pin  TEXT NOT NULL,
        idx  INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (pin, idx)
      );
      CREATE TABLE IF NOT EXISTS events (
        kind TEXT NOT NULL,
        ip   TEXT NOT NULL,
        ts   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts);
      CREATE TABLE IF NOT EXISTS retired (
        pin TEXT PRIMARY KEY,
        ts  INTEGER NOT NULL
      );
    `);
  }

  get cfg() {
    return readConfig(this.env);
  }

  // ---------------------------------------------------------------- helpers

  #one(query, ...args) {
    const rows = this.sql.exec(query, ...args).toArray();
    return rows[0] ?? null;
  }

  #countEvents(kind, since, ip) {
    const row = ip
      ? this.#one("SELECT COUNT(*) AS n, MIN(ts) AS first FROM events WHERE kind = ? AND ts > ? AND ip = ?", kind, since, ip)
      : this.#one("SELECT COUNT(*) AS n, MIN(ts) AS first FROM events WHERE kind = ? AND ts > ?", kind, since);
    return { n: row?.n ?? 0, first: row?.first ?? null };
  }

  #retryAfter(first, now) {
    return Math.max(1, Math.ceil((first + this.cfg.windowMs - now) / 1000));
  }

  #deleteFile(pin, now) {
    this.sql.exec("DELETE FROM chunks WHERE pin = ?", pin);
    this.sql.exec("DELETE FROM files WHERE pin = ?", pin);
    this.sql.exec("INSERT OR REPLACE INTO retired (pin, ts) VALUES (?, ?)", pin, now);
  }

  #sweep(now) {
    const expired = this.sql.exec("SELECT pin FROM files WHERE expires <= ?", now).toArray();
    for (const { pin } of expired) this.#deleteFile(pin, now);
    this.sql.exec("DELETE FROM events WHERE ts <= ?", now - this.cfg.windowMs);
    this.sql.exec("DELETE FROM retired WHERE ts <= ?", now - PIN_COOLDOWN_MS);
  }

  async #scheduleCleanup() {
    const next = this.#one("SELECT MIN(expires) AS t FROM files")?.t;
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  #freshPin() {
    for (let i = 0; i < 200; i++) {
      const pin = randomPin();
      const taken =
        this.#one("SELECT 1 AS x FROM files WHERE pin = ?", pin) ||
        this.#one("SELECT 1 AS x FROM retired WHERE pin = ?", pin);
      if (!taken) return pin;
    }
    return null;
  }

  // Shared by peek/take: enforce limits, then look the PIN up.
  #lookup(pin, ip, now) {
    const cfg = this.cfg;
    const since = now - cfg.windowMs;

    const mine = this.#countEvents("fail", since, ip);
    if (mine.n >= cfg.failsPerIp) {
      return { error: "LOCKED", retryAfter: this.#retryAfter(mine.first, now) };
    }
    const everyone = this.#countEvents("fail", since);
    if (everyone.n >= cfg.failsGlobal) {
      return { error: "LOCKED_GLOBAL", retryAfter: this.#retryAfter(everyone.first, now) };
    }

    const file = this.#one("SELECT * FROM files WHERE pin = ? AND expires > ?", pin, now);
    if (!file) {
      this.sql.exec("INSERT INTO events (kind, ip, ts) VALUES ('fail', ?, ?)", ip, now);
      return { error: "NOT_FOUND", attemptsLeft: Math.max(0, cfg.failsPerIp - mine.n - 1) };
    }
    return { file };
  }

  // ------------------------------------------------------------- RPC methods

  async upload({ name, bytes, ttlMin, once, ip }) {
    const cfg = this.cfg;
    const now = Date.now();
    this.#sweep(now);

    const ups = this.#countEvents("upload", now - cfg.windowMs, ip);
    if (ups.n >= cfg.uploadsPerIp) {
      return { error: "UPLOAD_LIMIT", retryAfter: this.#retryAfter(ups.first, now) };
    }

    const size = bytes.byteLength;
    const usage = this.#one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM files");
    if (usage.n >= cfg.maxActive || usage.total + size > cfg.maxTotalBytes) {
      return { error: "FULL" };
    }

    const pin = this.#freshPin();
    if (!pin) return { error: "FULL" };

    const ttl = cfg.ttlOptions.includes(ttlMin) ? ttlMin : cfg.defaultTtl;
    const expires = now + ttl * 60 * 1000;
    const token = randomToken();
    const view = new Uint8Array(bytes);
    const chunkCount = Math.max(1, Math.ceil(size / CHUNK_BYTES));

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO files (pin, name, size, created, expires, once, token, chunks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        pin, name, size, now, expires, once ? 1 : 0, token, chunkCount
      );
      for (let i = 0; i < chunkCount; i++) {
        const slice = view.slice(i * CHUNK_BYTES, Math.min(size, (i + 1) * CHUNK_BYTES));
        this.sql.exec("INSERT INTO chunks (pin, idx, data) VALUES (?, ?, ?)", pin, i, slice.buffer);
      }
      this.sql.exec("INSERT INTO events (kind, ip, ts) VALUES ('upload', ?, ?)", ip, now);
    });

    await this.#scheduleCleanup();
    return { pin, token, name, size, once: !!once, expiresIn: expires - now };
  }

  async peek({ pin, ip }) {
    const now = Date.now();
    this.#sweep(now);
    const r = this.#lookup(pin, ip, now);
    if (!r.file) return r;
    const f = r.file;
    return { name: f.name, size: f.size, once: !!f.once, expiresIn: f.expires - now };
  }

  async take({ pin, ip }) {
    const now = Date.now();
    this.#sweep(now);
    const r = this.#lookup(pin, ip, now);
    if (!r.file) return r;
    const f = r.file;

    const out = new Uint8Array(f.size);
    let offset = 0;
    for (const row of this.sql.exec("SELECT data FROM chunks WHERE pin = ? ORDER BY idx", pin)) {
      const part = new Uint8Array(row.data);
      out.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== f.size) return { error: "CORRUPT" };

    if (f.once) this.#deleteFile(pin, now);
    else this.sql.exec("UPDATE files SET downloads = downloads + 1 WHERE pin = ?", pin);
    await this.#scheduleCleanup();

    return { name: f.name, size: f.size, once: !!f.once, bytes: out.buffer };
  }

  async burn({ pin, token }) {
    const now = Date.now();
    const f = this.#one("SELECT token FROM files WHERE pin = ?", pin);
    if (!f || !sameString(f.token, token)) return { error: "NOT_FOUND" };
    this.#deleteFile(pin, now);
    await this.#scheduleCleanup();
    return { ok: true };
  }

  async alarm() {
    this.#sweep(Date.now());
    await this.#scheduleCleanup();
  }
}
