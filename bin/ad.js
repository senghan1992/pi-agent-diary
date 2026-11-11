#!/usr/bin/env node
// In a source checkout run src/ directly (Node >= 22.18 strips types), so a stale dist/ can never
// shadow your edits. Installed from npm (under node_modules/, where Node refuses to strip types),
// run the compiled dist/.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = new URL("../src/cli.ts", import.meta.url);
const dist = new URL("../dist/cli.js", import.meta.url);
const installed = fileURLToPath(import.meta.url).split(/[\\/]/).includes("node_modules");
await import((installed || !existsSync(src)) && existsSync(dist) ? dist.href : src.href);
