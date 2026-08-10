import { runRetentionSweep } from "../lib/retention/service";

const result = await runRetentionSweep();
console.log(
  `retention sweep complete: auto-deleted=${result.autoDeleted} purged=${result.purged}`,
);
process.exit(0);
