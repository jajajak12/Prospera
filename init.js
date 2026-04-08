/**
 * init.js — Must be imported FIRST before any other module.
 * Loads .env into process.env before any module-level side-effects run.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

try {
  const env = fs.readFileSync(envPath, "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!Object.prototype.hasOwnProperty.call(process.env, m[1])) {
        process.env[m[1]] = val;
      }
    }
  }
} catch (_) {}