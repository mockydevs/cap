// Google Meet: tells Cap when this tab's call has ended, and shows a banner
// when a calendar event with "Include Cap" starts. Meet's markup changes
// over time; the tab-closed and idle checks still stop a recording if this
// detection misses.
(() => {
  const ENDED =
    /you left the meeting|you've left the meeting|the call has ended|you were removed from the meeting/i;
  let reported = false;

  function check() {
    if (reported) return;
    const text = document.body?.innerText?.slice(0, 5_000) ?? "";
    const rejoin = [...document.querySelectorAll("button")].some((b) =>
      /^\s*rejoin\s*$/i.test(b.innerText),
    );
    if (ENDED.test(text) || rejoin) {
      reported = true;
      chrome.runtime.sendMessage({ type: "meet-ended" }).catch(() => {});
    }
  }

  new MutationObserver(check).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "cap-scheduled" || document.getElementById("cap-banner"))
      return;
    const b = document.createElement("div");
    b.id = "cap-banner";
    b.setAttribute("role", "status");
    b.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:8px;background:#0b57d0;color:#fff;font:14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    b.textContent = `Cap is set to record "${msg.title}" (${msg.mode === "video" ? "video" : "audio"}). Click the Cap icon and Start, or press Alt+Shift+R.`;
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.style.cssText =
      "margin-left:12px;background:none;border:0;color:inherit;font-size:16px;cursor:pointer";
    close.onclick = () => b.remove();
    b.append(close);
    document.body.append(b);
  });
})();
