// Screenshots of the local fixture (synthetic data only). Usage: node shots.cjs fixture.json outdir
const { chromium } = require("/home/don/code/zuri-logistics-admin-secondary/node_modules/playwright");
const fs = require("fs");
const [fixturePath, out] = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const [name, value] = fx.cookie.split("=");
const m = fx.meetings;

(async () => {
  const browser = await chromium.launch();
  const report = [];
  for (const [label, viewport, mobile] of [
    ["desktop", { width: 1440, height: 900 }, false],
    ["mobile", { width: 390, height: 844 }, true],
  ]) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    await ctx.addCookies([{ name, value, url: fx.base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    const shot = async (file, full = true) => {
      await page.screenshot({ path: `${out}/${label}-${file}.png`, fullPage: full });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      report.push({ label, file, url: page.url().replace(fx.base, ""), overflow });
    };
    await page.goto(`${fx.base}/meetings`);
    if ((await page.content()).includes("OTHER TENANT")) throw new Error("tenant leak");
    await shot("01-list");
    // Expand the first row with the keyboard.
    await page.focus("summary.row");
    await page.keyboard.press("Enter");
    await page.waitForSelector("details.meeting[open] .panel-grid");
    await shot("02-list-expanded");
    await page.goto(`${fx.base}/meetings?status=attention`);
    await shot("03-filter-needs-attention");
    await page.goto(`${fx.base}/meetings?q=zzzz-nothing`);
    await shot("04-empty-search");
    await page.goto(`${fx.base}/meetings?view=archived`);
    await shot("05-archived");
    await page.goto(`${fx.base}/meetings/${m[0]}`);
    await shot("06-meeting");
    // Add a note through the real form.
    await page.fill("#new-note", "Synthetic note from the screenshot run.\nSecond line.");
    await Promise.all([page.waitForNavigation(), page.click(".note-new button[type=submit]")]);
    await shot("07-note-added");
    // Stale edit: change the note in the DB-backed form from two tabs.
    const editSummary = page.locator(".note .inline-edit summary").first();
    await editSummary.click();
    const other = await ctx.newPage();
    await other.goto(`${fx.base}/meetings/${m[0]}`);
    await other.locator(".note .inline-edit summary").first().click();
    await other.locator(".note .inline-edit textarea").first().fill("Saved first from another tab.");
    await Promise.all([other.waitForNavigation(), other.locator(".note .inline-edit button[type=submit]").first().click()]);
    await other.close();
    await page.locator(".note .inline-edit textarea").first().fill("My edit, made on an old copy.");
    await Promise.all([page.waitForNavigation(), page.locator(".note .inline-edit button[type=submit]").first().click()]);
    await shot("08-conflict-kept-draft");
    await page.goto(`${fx.base}/meetings/${m[0]}?confirm=archive#top`);
    await shot("09-confirm-archive", false);
    await page.goto(`${fx.base}/meetings/${m[3]}`);
    await shot("10-failed-meeting");
    await page.goto(`${fx.base}/meetings/${m[5]}`);
    await shot("11-recording-meeting");
    // Keyboard focus is visible on a row.
    await page.goto(`${fx.base}/meetings`);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await shot("12-keyboard-focus", false);
    const r = await page.goto(`${fx.base}/meetings/${fx.other}`);
    report.push({ label, file: "other-tenant", status: r.status() });
    report.push({ label, consoleErrors: errors });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
