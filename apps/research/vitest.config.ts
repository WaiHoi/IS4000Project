import { defineConfig } from "vitest/config";

// Default `pnpm test`: compose-free unit tests only. DB-backed cases live
// under test/integration (see vitest.integration.config.ts).
export default defineConfig({
	test: {
		exclude: ["test/integration/**", "**/node_modules/**"],
	},
});
