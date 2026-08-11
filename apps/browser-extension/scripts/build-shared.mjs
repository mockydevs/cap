import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await mkdir(new URL("src/vendor/", root), { recursive: true });

await build({
  entryPoints: [
    new URL("../../../packages/recording/src/index.ts", import.meta.url)
      .pathname,
  ],
  outfile: new URL("src/vendor/recording.js", root).pathname,
  bundle: false,
  format: "esm",
  target: "chrome109",
  logLevel: "info",
});

await build({
  entryPoints: [
    new URL(
      "../../../apps/web/lib/uploads/resumable-client.ts",
      import.meta.url,
    ).pathname,
  ],
  outfile: new URL("src/vendor/resumable-client.js", root).pathname,
  bundle: false,
  format: "esm",
  target: "chrome109",
  logLevel: "info",
});
