// Test-process-only fixture. This is not exposed through an application route.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let url;
try {
  url = new URL(process.env.DATABASE_URL ?? "");
} catch {
  throw new Error(
    "Legacy E2E fixtures require an explicit loopback *_test database",
  );
}
if (
  !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
  url.search ||
  url.hash ||
  !new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) ||
  !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname)
) {
  throw new Error(
    "Legacy E2E fixtures require an explicit loopback *_test database",
  );
}
const { displayName, workspaceName, email } = JSON.parse(
  readFileSync(0, "utf8"),
);
if (
  ![displayName, workspaceName, email].every(
    (value) =>
      typeof value === "string" && value.length > 0 && value.length <= 200,
  ) ||
  !email.endsWith("@example.com")
)
  throw new Error("Invalid local test identity");
const { Client } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("pg");
const client = new Client({ connectionString: url.toString() });
const userId = randomUUID();
const workspaceId = randomUUID();
const token = randomBytes(32).toString("base64url");
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    "INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)",
    [userId, email, "public-credentials-disabled-e2e-fixture", displayName],
  );
  await client.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
    workspaceId,
    workspaceName,
  ]);
  await client.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'OWNER')",
    [workspaceId, userId],
  );
  await client.query(
    "INSERT INTO sessions(id,token_hash,user_id,active_workspace_id,expires_at) VALUES($1,$2,$3,$4,$5)",
    [
      randomUUID(),
      createHash("sha256").update(token).digest("hex"),
      userId,
      workspaceId,
      new Date(Date.now() + 60 * 60 * 1000),
    ],
  );
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ token }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
