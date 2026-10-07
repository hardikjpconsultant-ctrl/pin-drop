// Quick end-to-end check of the API.
//   Local:     npm run dev   (in another terminal), then: npm test
//   Deployed:  BASE_URL=https://pin-drop.<you>.workers.dev npm test
// Uses 1 upload and 1 wrong-PIN attempt from your network.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
let failed = 0;
const check = (ok, label) => {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failed++;
};

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: "POST", body, headers });

const cfg = await (await fetch(BASE + "/api/config")).json();
check(cfg.maxBytes > 0, `config loads (max ${cfg.maxBytes / 1048576} MB)`);

const original = new Uint8Array(512 * 1024);
for (let i = 0; i < original.length; i += 65536) {
  crypto.getRandomValues(original.subarray(i, i + 65536));
}
const up = await post("/api/upload", original, {
  "Content-Type": "application/octet-stream",
  "X-File-Name": encodeURIComponent("smoke test.csv"),
  "X-TTL-Min": String(cfg.ttlOptions[0]),
  "X-Once": "1",
});
const sent = await up.json();
check(up.status === 201 && /^\d{4}$/.test(sent.pin), `upload returns a PIN (${sent.pin})`);

const json = { "Content-Type": "application/json" };
const peek = await post("/api/peek", JSON.stringify({ pin: sent.pin }), json);
const info = await peek.json();
check(peek.ok && info.name === "smoke test.csv", "PIN lookup finds the file");

const dl = await post("/api/download", JSON.stringify({ pin: sent.pin }), json);
const got = new Uint8Array(await dl.arrayBuffer());
const same = got.length === original.length && got.every((b, i) => b === original[i]);
check(dl.ok && same, "downloaded bytes are identical");

const again = await post("/api/peek", JSON.stringify({ pin: sent.pin }), json);
check(again.status === 404, "file is erased after first download");

const big = await post("/api/upload", new Uint8Array(cfg.maxBytes + 1), {
  "Content-Type": "application/octet-stream",
  "X-File-Name": "big.pdf",
});
check(big.status === 413, "over-size upload is rejected");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
