import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
await mkdir(new URL("src/vendor/", root), { recursive: true });

await build({
  entryPoints: [
    fileURLToPath(
      new URL("../../../packages/recording/src/index.ts", import.meta.url),
    ),
  ],
  outfile: fileURLToPath(new URL("src/vendor/recording.js", root)),
  bundle: false,
  format: "esm",
  target: "chrome109",
  logLevel: "info",
});

await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        "../../../apps/web/lib/uploads/resumable-client.ts",
        import.meta.url,
      ),
    ),
  ],
  outfile: fileURLToPath(new URL("src/vendor/resumable-client.js", root)),
  bundle: false,
  format: "esm",
  target: "chrome109",
  logLevel: "info",
});
