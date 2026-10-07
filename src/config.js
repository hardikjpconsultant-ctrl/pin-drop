// Reads the settings from wrangler.jsonc "vars" with safe fallbacks.

const MB = 1024 * 1024;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readConfig(env = {}) {
  let ttlOptions = String(env.TTL_OPTIONS_MIN ?? "5,15,60")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 1440);
  ttlOptions = [...new Set(ttlOptions)].sort((a, b) => a - b);
  if (ttlOptions.length === 0) ttlOptions = [15];

  const wantedDefault = Number(env.DEFAULT_TTL_MIN);
  const defaultTtl = ttlOptions.includes(wantedDefault) ? wantedDefault : ttlOptions[0];

  const extRaw = String(env.ALLOWED_EXT ?? "*").trim();
  const allowedExt =
    extRaw === "*" || extRaw === ""
      ? null // any type
      : extRaw
          .split(",")
          .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
          .filter(Boolean);

  return {
    maxBytes: Math.floor(positive(env.MAX_FILE_MB, 10) * MB),
    ttlOptions,
    defaultTtl,
    onceDefault: String(env.ONCE_DEFAULT ?? "true") !== "false",
    allowedExt,
    windowMs: 10 * 60 * 1000,
    failsPerIp: positive(env.FAILS_PER_IP, 5),
    failsGlobal: positive(env.FAILS_GLOBAL, 20),
    uploadsPerIp: positive(env.UPLOADS_PER_IP, 10),
    maxActive: positive(env.MAX_ACTIVE_FILES, 20),
    maxTotalBytes: Math.floor(positive(env.MAX_TOTAL_MB, 200) * MB),
  };
}

// Strip anything that could be a path or control character; keep it short.
export function cleanName(raw) {
  let name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  if (!name || name === "." || name === "..") name = "file";
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

export function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
