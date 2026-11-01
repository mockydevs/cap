// Plays a meeting's parts back to back as one timeline and lets transcript
// timestamps jump to the right part. No other script runs on Cap pages.
(() => {
  const box = document.getElementById("playlist");
  const player = document.getElementById("player");
  if (!box || !player) return;
  const parts = JSON.parse(box.dataset.parts || "[]");
  const position = document.getElementById("position");
  let index = -1;
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  function load(i, offsetSeconds, play) {
    index = i;
    player.src = parts[i].url;
    player.addEventListener("loadedmetadata", () => {
      if (offsetSeconds) player.currentTime = offsetSeconds;
      if (play) player.play().catch(() => {});
    }, { once: true });
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
    let i = parts.findIndex((p) => t >= p.start_ms && t < p.start_ms + p.duration_ms);
    if (i < 0) i = t < (parts[0]?.start_ms ?? 0) ? 0 : parts.length - 1;
    load(i, Math.max(0, (t - parts[i].start_ms) / 1000), true);
  });
  if (parts.length) load(0, 0, false);
})();
