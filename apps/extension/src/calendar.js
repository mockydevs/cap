// Google Calendar: adds "Include Cap?" next to an event's description. The
// choice is written into the description as "[Cap: record audio]" or
// "[Cap: record video]", so guests can see the meeting will be recorded and
// the extension can find it later through the read-only Calendar API.
// Calendar's markup is not a stable API: if the description box cannot be
// found, nothing is injected and the marker can be typed by hand.
(() => {
  const MARKER = /\s*\[Cap:\s*record\s+(audio|video)\]\s*/i;
  const PANEL = "cap-include-panel";

  function editors() {
    return [
      ...document.querySelectorAll(
        '[contenteditable="true"][aria-label*="escription" i], [contenteditable="true"][aria-label*="Add description" i]',
      ),
    ];
  }

  function currentMode(editor) {
    return MARKER.exec(editor.innerText)?.[1]?.toLowerCase() ?? "none";
  }

  function setMode(editor, mode) {
    // Remove an existing marker by editing only the text node that holds it.
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (MARKER.test(n.nodeValue))
        n.nodeValue = n.nodeValue.replace(MARKER, " ").trimEnd();
    }
    if (mode !== "none") {
      editor.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(editor);
      sel.collapseToEnd();
      // insertText goes through the editor's own input handling, so Calendar saves it.
      document.execCommand(
        "insertText",
        false,
        `${editor.innerText.trim() ? "\n" : ""}[Cap: record ${mode}]`,
      );
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  function inject(editor) {
    if (editor.parentElement?.querySelector(`.${PANEL}`)) return;
    const panel = document.createElement("div");
    panel.className = PANEL;
    panel.style.cssText =
      "display:flex;gap:12px;align-items:center;margin:6px 0;font:13px system-ui,sans-serif";
    const label = document.createElement("span");
    label.textContent = "Include Cap?";
    label.style.fontWeight = "600";
    const select = document.createElement("select");
    for (const [value, text] of [
      ["none", "No"],
      ["audio", "Record audio + transcript"],
      ["video", "Record video + transcript"],
    ]) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      select.append(o);
    }
    select.value = currentMode(editor);
    select.onchange = () => setMode(editor, select.value);
    panel.append(label, select);
    editor.parentElement?.insertBefore(panel, editor);
  }

  new MutationObserver(() => editors().forEach(inject)).observe(document.body, {
    childList: true,
    subtree: true,
  });
  editors().forEach(inject);
})();
