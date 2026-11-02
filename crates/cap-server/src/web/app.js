// Cap library script. Pages work without it; this adds playback across
// parts, draft keeping, a double-submit guard and an unsaved-changes warning.
(() => {
  // ---- Drafts: kept per tab in sessionStorage, never sent anywhere. ----
  const PREFIX = "cap.draft.";
  const store = {
    get(k) {
      try {
        return sessionStorage.getItem(PREFIX + k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        sessionStorage.setItem(PREFIX + k, v);
      } catch {}
    },
    del(k) {
      try {
        sessionStorage.removeItem(PREFIX + k);
      } catch {}
    },
    clearAll() {
      try {
        for (const k of Object.keys(sessionStorage))
          if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
      } catch {}
    },
  };
  const saved = document.body.dataset.savedDraft;
  if (saved) store.del(saved);

  const fields = [...document.querySelectorAll("[data-draft]")];
  const stateFor = (el) =>
    el.closest("form")?.querySelector(".draft-state") || null;
  for (const el of fields) {
    const key = el.dataset.draft;
    const kept = store.get(key);
    // The server's own copy of a rejected draft wins over the stored one.
    if (!("serverDraft" in el.dataset) && kept !== null && kept !== el.value) {
      el.value = kept;
      const det = el.closest("details");
      if (det) det.open = true;
      const s = stateFor(el);
      if (s) {
        s.textContent = "Unsaved draft restored. ";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "link";
        b.textContent = "Discard draft";
        b.addEventListener("click", () => {
          el.value = el.defaultValue;
          store.del(key);
          s.textContent = "Draft discarded.";
        });
        s.append(b);
      }
    }
    el.addEventListener("input", () => {
      if (el.value === el.defaultValue) store.del(key);
      else store.set(key, el.value);
    });
    if (el.tagName === "TEXTAREA")
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          el.form?.requestSubmit();
        }
      });
  }

  // ---- One submit per form; warn before leaving unsaved text. ----
  let leaving = false;
  for (const form of document.querySelectorAll("form[data-guard]")) {
    form.addEventListener("submit", (e) => {
      if (form.dataset.busy) {
        e.preventDefault();
        return;
      }
      form.dataset.busy = "1";
      leaving = true;
      for (const b of form.querySelectorAll("button[type=submit]")) {
        b.setAttribute("aria-disabled", "true");
        b.dataset.label = b.textContent;
        b.textContent = "Saving…";
      }
    });
  }
  // Coming back with the browser's Back button re-enables the forms.
  window.addEventListener("pageshow", () => {
    leaving = false;
    for (const form of document.querySelectorAll("form[data-busy]")) {
      delete form.dataset.busy;
      for (const b of form.querySelectorAll("button[aria-disabled]")) {
        b.removeAttribute("aria-disabled");
        if (b.dataset.label) b.textContent = b.dataset.label;
      }
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (leaving) return;
    if (fields.some((el) => el.value !== el.defaultValue)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  for (const f of document.querySelectorAll("form[data-signout]"))
    f.addEventListener("submit", () => {
      leaving = true;
      store.clearAll();
    });

  // ---- Player: plays a meeting's parts back to back as one timeline and
  // lets transcript timestamps jump to the right part. ----
  const box = document.getElementById("playlist");
  const player = document.getElementById("player");
  if (!box || !player) return;
  const parts = JSON.parse(box.dataset.parts || "[]");
  const position = document.getElementById("position");
  let index = -1;
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  function load(i, offsetSeconds, play) {
    index = i;
    player.src = parts[i].url;
    player.addEventListener(
      "loadedmetadata",
      () => {
        if (offsetSeconds) player.currentTime = offsetSeconds;
        if (play) player.play().catch(() => {});
      },
      { once: true },
    );
  }
  player.addEventListener("ended", () => {
    if (index + 1 < parts.length) load(index + 1, 0, true);
  });
  const segs = [...document.querySelectorAll(".segments li")];
  player.addEventListener("timeupdate", () => {
    if (index < 0) return;
    const now = parts[index].start_ms + player.currentTime * 1000;
    if (position) position.textContent = fmt(now);
    for (const li of segs) {
      const start = Number(li.querySelector("[data-seek]")?.dataset.seek || 0);
      const next = li.nextElementSibling?.querySelector("[data-seek]");
      const end = next ? Number(next.dataset.seek) : Infinity;
      li.classList.toggle("current", now >= start && now < end);
    }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seek]");
    if (!b) return;
    const t = Number(b.dataset.seek);
    let i = parts.findIndex(
      (p) => t >= p.start_ms && t < p.start_ms + p.duration_ms,
    );
    if (i < 0) i = t < (parts[0]?.start_ms ?? 0) ? 0 : parts.length - 1;
    load(i, Math.max(0, (t - parts[i].start_ms) / 1000), true);
  });
  if (parts.length) load(0, 0, false);
})();
