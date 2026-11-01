// Points each download button at the newest published file of that type.
// Release file names include the version, so they are looked up rather than
// hard-coded. Without JavaScript, or if GitHub is unreachable, every button
// still opens the releases page.
(async () => {
  const note = document.getElementById("release-note");
  const match = {
    windows: (n) => /-setup\.exe$/i.test(n) || /\.exe$/i.test(n),
    "mac-arm": (n) => /(aarch64|arm64).*\.dmg$/i.test(n),
    "mac-intel": (n) => /(x64|x86_64|intel).*\.dmg$/i.test(n),
    linux: (n) => /\.deb$/i.test(n),
    extension: (n) => /chrom.*extension.*\.zip$/i.test(n),
  };
  const ua = navigator.userAgent;
  const guess = /Windows/.test(ua)
    ? "windows"
    : /Mac/.test(ua)
      ? "mac-arm"
      : /Linux/.test(ua) && !/Android/.test(ua)
        ? "linux"
        : null;
  if (guess)
    document
      .querySelector(`[data-asset="${guess}"]`)
      ?.classList.add("recommended");
  try {
    const res = await fetch(
      "https://api.github.com/repos/mockydevs/cap/releases?per_page=20",
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(String(res.status));
    const releases = (await res.json()).filter((r) => !r.draft);
    let desktopVersion = null;
    for (const a of document.querySelectorAll("[data-asset]")) {
      const kind = a.dataset.asset;
      const release = releases.find((r) =>
        r.assets.some((x) => match[kind](x.name)),
      );
      const asset = release?.assets.find((x) => match[kind](x.name));
      if (asset) {
        a.href = asset.browser_download_url;
        if (kind !== "extension") desktopVersion ??= release.tag_name;
      } else {
        a.setAttribute("aria-disabled", "true");
        a.querySelector("small").textContent = "Not published yet";
      }
    }
    note.textContent = desktopVersion
      ? `Latest desktop version: ${desktopVersion}.`
      : "The desktop app has not been published yet. The buttons open the releases page.";
  } catch {
    note.textContent =
      "Could not check for the latest version. The buttons open the releases page.";
  }
})();
