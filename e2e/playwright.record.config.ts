import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// Recording-only config: same stack/spec, but keeps the browser video and
// slows the UI just enough to be watchable. Output: e2e/recordings/<test>/video.webm
export default defineConfig({
	...base,
	use: {
		...base.use,
		viewport: { width: 1440, height: 900 },
		video: "on",
		launchOptions: { slowMo: 120 },
	},
	outputDir: "./recordings",
	reporter: [["list"]],
});
