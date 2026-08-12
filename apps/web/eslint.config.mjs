import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    // Client components intentionally load API-backed state when they mount.
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);
