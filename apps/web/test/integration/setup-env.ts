import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("./.integration-env.json", import.meta.url));

// setupFiles run in-process per test file, unlike globalSetup — this is
// what actually makes the env global-setup resolved (the KMS key ARN isn't
// known until it's created) visible to the tests.
const env = JSON.parse(readFileSync(ENV_FILE, "utf8")) as Record<string, string>;
for (const [key, value] of Object.entries(env)) process.env[key] = value;
