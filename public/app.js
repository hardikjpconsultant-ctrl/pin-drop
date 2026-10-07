/* PIN-DROP client. No libraries, no tracking, no cookies. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MB = 1024 * 1024;

  let config = null;
  let current = "boot";
  let busy = false;
  let picked = null;           // File chosen for sending
  let sent = null;             // { pin, token, ... } after upload
  let found = null;            // { pin, name, size, once, deadline } after lookup
  let timer = null;

  // ---------------------------------------------------------------- utils

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < MB) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / MB).toFixed(2) + " MB";
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function extOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function bar(frac) {
    const width = window.innerWidth < 520 ? 16 : 30;
    const f = Math.max(0, Math.min(1, frac || 0));
    const n = Math.round(f * width);
    return "[" + "#".repeat(n) + ".".repeat(width - n) + "] " + String(Math.round(f * 100)).padStart(3, " ") + "%";
  }

  function status(msg, isError) {
    const el = $("status");
    el.textContent = msg ? (isError ? "?" + msg : msg) : "";
    el.classList.toggle("err", !!isError);
  }

  function errorText(data, fallback) {
    if (!data || !data.message) return fallback || "SYSTEM ERROR";
    let msg = data.message;
    if (data.error === "NOT_FOUND" && typeof data.attemptsLeft === "number") {
      msg += " (" + data.attemptsLeft + " TRIES LEFT)";
    }
    if (data.retryAfter) msg += ". TRY AGAIN IN " + Math.ceil(data.retryAfter / 60) + " MIN";
    if (data.error === "TOO_LARGE" && data.maxBytes) msg += " (MAX " + Math.round(data.maxBytes / MB) + " MB)";
    return msg;
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function show(...ids) {
    for (const id of ids) $(id).hidden = false;
  }
  function hide(...ids) {
    for (const id of ids) $(id).hidden = true;
  }

  // ---------------------------------------------------------------- theme

  function setTheme(name) {
    if (name === "amber") document.documentElement.setAttribute("data-theme", "amber");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("pindrop-theme", name); } catch (_) { /* storage blocked */ }
  }
  function toggleTheme() {
    const amber = document.documentElement.getAttribute("data-theme") === "amber";
    setTheme(amber ? "green" : "amber");
  }
  try {
    if (localStorage.getItem("pindrop-theme") === "amber") setTheme("amber");
  } catch (_) { /* storage blocked */ }

  // ---------------------------------------------------------------- views

  function go(view) {
    if (busy) return;
    stopTimer();
    status("");
    for (const v of ["boot", "menu", "send", "receive"]) $(v).hidden = v !== view;
    current = view;
    if (view === "menu") {
      document.querySelector('.menu-item[data-go="send"]').focus();
    } else if (view === "send") {
      resetSend();
    } else if (view === "receive") {
      resetReceive();
    }
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    const lines = [
      "PIN-DROP BIOS V1.0  (C) 1984",
      "MEMORY TEST ...... 640K OK",
      "LINK TO HOST ..... ",
    ];
    const out = $("boot-text");
    const fast = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));
    let skip = false;
    const skipper = () => { skip = true; };
    window.addEventListener("keydown", skipper, { once: true });
    window.addEventListener("pointerdown", skipper, { once: true });

    for (const line of lines) {
      out.textContent += line + (line.endsWith(" ") ? "" : "\n");
      if (!skip) await wait(170);
    }

    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      config = await res.json();
      out.textContent += "OK\n";
    } catch (_) {
      out.textContent += "FAILED\n\n?CANNOT REACH SERVER. CHECK YOUR CONNECTION AND RELOAD.";
      return;
    }

    out.textContent += "MAX FILE SIZE .... " + Math.round(config.maxBytes / MB) + " MB\n";
    if (!skip) await wait(170);
    out.textContent += "\nREADY.";
    if (!skip) await wait(260);
    window.removeEventListener("keydown", skipper);
    window.removeEventListener("pointerdown", skipper);
    applyConfig();
    go("menu");
  }

  function applyConfig() {
    for (const el of document.querySelectorAll("[data-max]")) {
      el.textContent = String(Math.round(config.maxBytes / MB));
    }
    const box = $("ttl-options");
    box.textContent = "";
    for (const min of config.ttlOptions) {
      const label = document.createElement("label");
      label.className = "radio";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "ttl";
      input.value = String(min);
      input.className = "sr-only";
      if (min === config.defaultTtl) input.checked = true;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.setAttribute("aria-hidden", "true");
      label.append(input, mark, document.createTextNode(min >= 60 && min % 60 === 0 ? (min / 60) + " HR" : min + " MIN"));
      box.append(label);
    }
    $("accepts").textContent = config.allowedExt
      ? "ACCEPTS: " + config.allowedExt.map((e) => e.toUpperCase()).join(" ")
      : "ACCEPTS: ANY FILE TYPE";
  }

  // ---------------------------------------------------------------- send

  function resetSend() {
    picked = null;
    sent = null;
    $("file").value = "";
    $("file-info").textContent = "NO FILE SELECTED.";
    $("file-info").className = "dim";
    $("send-go").disabled = true;
    $("once").checked = config ? config.onceDefault : true;
    show("send-form");
    hide("send-progress", "send-done");
  }

  function pick(file) {
    status("");
    picked = null;
    $("send-go").disabled = true;
    if (!file) return;
    const info = $("file-info");
    if (config.allowedExt && !config.allowedExt.includes(extOf(file.name))) {
      info.textContent = "FILE: " + file.name;
      info.className = "dim";
      status("FILE TYPE NOT ALLOWED", true);
      return;
    }
    if (file.size > config.maxBytes) {
      info.textContent = "FILE: " + file.name + "  (" + fmtSize(file.size) + ")";
      info.className = "dim";
      status("FILE TOO LARGE (MAX " + Math.round(config.maxBytes / MB) + " MB)", true);
      return;
    }
    if (file.size === 0) {
      status("FILE IS EMPTY", true);
      return;
    }
    picked = file;
    info.textContent = "FILE: " + file.name + "  (" + fmtSize(file.size) + ")";
    info.className = "";
    $("send-go").disabled = false;
    $("send-go").focus();
  }

  function transmit() {
    if (!picked || busy) return;
    const ttlInput = document.querySelector('input[name="ttl"]:checked');
    const ttl = ttlInput ? ttlInput.value : String(config.defaultTtl);
    const once = $("once").checked;

    busy = true;
    status("");
    hide("send-form");
    show("send-progress");
    $("up-name").textContent = picked.name;
    $("up-bar").textContent = bar(0);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(picked.name));
    xhr.setRequestHeader("X-TTL-Min", ttl);
    xhr.setRequestHeader("X-Once", once ? "1" : "0");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $("up-bar").textContent = bar(e.loaded / e.total);
    };
    xhr.onload = () => {
      busy = false;
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* not json */ }
      if (xhr.status === 201 && data && data.pin) {
        $("up-bar").textContent = bar(1);
        sent = data;
        sent.deadline = Date.now() + data.expiresIn;
        showPin();
      } else {
        hide("send-progress");
        show("send-form");
        status(errorText(data, "UPLOAD FAILED"), true);
      }
    };
    xhr.onerror = () => {
      busy = false;
      hide("send-progress");
      show("send-form");
      status("CONNECTION LOST DURING UPLOAD", true);
    };
    xhr.send(picked);
  }

  function showPin() {
    hide("send-progress");
    show("send-done");
    $("pin-out").textContent = sent.pin;
    $("host").textContent = location.host;
    const render = () => {
      const left = sent.deadline - Date.now();
      const lines = [
        "FILE   : " + sent.name,
        "SIZE   : " + fmtSize(sent.size),
        "ERASES : " + (left > 0 ? "IN " + fmtClock(left) : "NOW") + (sent.once ? "  OR AFTER FIRST DOWNLOAD" : ""),
      ];
      $("send-readout").textContent = lines.join("\n");
      if (left <= 0) {
        stopTimer();
        $("pin-out").textContent = "----";
        status("FILE EXPIRED AND ERASED.");
        $("burn").disabled = true;
      }
    };
    $("burn").disabled = false;
    render();
    stopTimer();
    timer = setInterval(render, 1000);
    $("send-again").focus();
  }

  async function burn() {
    if (!sent || busy) return;
    busy = true;
    try {
      const res = await fetch("/api/burn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: sent.pin, token: sent.token }),
      });
      busy = false;
      stopTimer();
      $("pin-out").textContent = "----";
      $("burn").disabled = true;
      status(res.ok ? "FILE ERASED FROM SERVER." : "FILE ALREADY GONE (DOWNLOADED OR EXPIRED).");
      $("send-readout").textContent = "FILE   : " + sent.name + "\nSTATUS : ERASED";
    } catch (_) {
      busy = false;
      status("CONNECTION ERROR - COULD NOT ERASE", true);
    }
  }

  // ---------------------------------------------------------------- receive

  function resetReceive() {
    found = null;
    $("pin-in").value = "";
    $("pin-in").disabled = false;
    $("lookup").disabled = false;
    show("pin-form");
    hide("found", "recv-progress", "recv-done");
    setTimeout(() => $("pin-in").focus(), 0);
  }

  async function lookup() {
    if (busy) return;
    const pin = $("pin-in").value.trim();
    if (!/^\d{4}$/.test(pin)) {
      status("PIN MUST BE 4 DIGITS", true);
      return;
    }
    busy = true;
    status("SEARCHING ...");
    hide("found");
    try {
      const res = await fetch("/api/peek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => null);
      busy = false;
      if (!res.ok) {
        status(errorText(data, "LOOKUP FAILED"), true);
        $("pin-in").select();
        return;
      }
      status("");
      found = { pin, ...data, deadline: Date.now() + data.expiresIn };
      $("pin-in").disabled = true;
      $("lookup").disabled = true;
      show("found");
      const render = () => {
        const left = found.deadline - Date.now();
        $("found-readout").textContent = [
          "FILE FOUND",
          "NAME   : " + found.name,
          "SIZE   : " + fmtSize(found.size),
          "ERASES : " + (left > 0 ? "IN " + fmtClock(left) : "NOW") + (found.once ? "  OR AFTER THIS DOWNLOAD" : ""),
        ].join("\n");
        if (left <= 0) {
          stopTimer();
          $("get").disabled = true;
          status("FILE EXPIRED.", true);
        }
      };
      $("get").disabled = false;
      render();
      stopTimer();
      timer = setInterval(render, 1000);
      $("get").focus();
    } catch (_) {
      busy = false;
      status("CONNECTION ERROR", true);
    }
  }

  async function download() {
    if (!found || busy) return;
    busy = true;
    stopTimer();
    status("");
    hide("found", "pin-form");
    show("recv-progress");
    $("down-bar").textContent = bar(0);
    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: found.pin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(errorText(data, "DOWNLOAD FAILED"));
      }
      const total = Number(res.headers.get("Content-Length")) || found.size;
      const chunks = [];
      let got = 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.byteLength;
          $("down-bar").textContent = bar(got / total);
        }
      } else {
        chunks.push(new Uint8Array(await res.arrayBuffer()));
      }
      $("down-bar").textContent = bar(1);
      save(new Blob(chunks, { type: "application/octet-stream" }), found.name);
      busy = false;
      hide("recv-progress");
      show("recv-done");
      $("recv-note").textContent = found.once
        ? "FILE: " + found.name + " - NOW ERASED FROM THE SERVER."
        : "FILE: " + found.name + " - STILL AVAILABLE UNTIL IT EXPIRES.";
      $("recv-again").focus();
    } catch (err) {
      busy = false;
      hide("recv-progress");
      resetReceive();
      status(err && err.message ? err.message : "DOWNLOAD FAILED", true);
    }
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 10000);
  }

  // ---------------------------------------------------------------- events

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-go]");
    if (target) go(target.getAttribute("data-go"));
  });

  $("file").addEventListener("change", (e) => pick(e.target.files && e.target.files[0]));
  $("send-go").addEventListener("click", transmit);
  $("burn").addEventListener("click", burn);
  $("send-again").addEventListener("click", () => resetSend());
  $("theme").addEventListener("click", toggleTheme);

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pick(f);
  });
  // Dropping a file anywhere else on the page shouldn't navigate away.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (current === "send" && !$("send-form").hidden) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) pick(f);
    }
  });

  const pinIn = $("pin-in");
  pinIn.addEventListener("input", () => {
    const digits = pinIn.value.replace(/\D/g, "").slice(0, 4);
    if (pinIn.value !== digits) pinIn.value = digits;
    if (digits.length === 4) lookup();
  });
  $("pin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    lookup();
  });
  $("get").addEventListener("click", download);
  $("recv-again").addEventListener("click", () => {
    status("");
    resetReceive();
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement && e.target.type === "text";
    if (e.key === "Escape" && current !== "menu" && current !== "boot") {
      e.preventDefault();
      go("menu");
      return;
    }
    if (typing) return;
    if (current === "menu" && e.key === "1") go("send");
    else if (current === "menu" && e.key === "2") go("receive");
    else if (e.key === "c" || e.key === "C") toggleTheme();
  });

  boot();
})();
