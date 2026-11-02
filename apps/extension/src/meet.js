// Google Meet: tells Cap when this tab's call has ended. It reads only the
// page's visible text and buttons and sends nothing but "call ended". Meet's
// markup changes over time; the tab-closed and idle checks still stop a recording if this
// detection misses.
(() => {
  const ENDED =
    /you left the meeting|you've left the meeting|the call has ended|you were removed from the meeting/i;
  // Reported once each time the page goes from "in a call" to "call ended".
  // Rejoining clears the ended screen, so the next end is reported again;
  // the background only acts on it for the tab that is recording.
  let ended = false;

  function check() {
    const text = document.body?.innerText?.slice(0, 5_000) ?? "";
    const rejoin = [...document.querySelectorAll("button")].some((b) =>
      /^\s*rejoin\s*$/i.test(b.innerText),
    );
    const now = ENDED.test(text) || rejoin;
    if (now && !ended)
      chrome.runtime.sendMessage({ type: "meet-ended" }).catch(() => {});
    ended = now;
  }

  new MutationObserver(check).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
