// Every e2e spec (regression suite). `pnpm test:e2e` runs only the three
// demo flows via playwright.config.ts.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({ ...base, testMatch: ["*.spec.ts"] });
