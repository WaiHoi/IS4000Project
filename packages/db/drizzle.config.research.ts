import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/research.ts",
	out: "./drizzle/research",
	dialect: "postgresql",
});
