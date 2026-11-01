import { describe, expect, it } from "vitest";
import { IntegrityAgentError } from "../../src/integrity/types.js";

describe("IntegrityAgentError cause metadata", () => {
	it("keeps the cause's class and HTTP status, never its message", () => {
		class APIError extends Error {
			constructor(
				readonly status: number,
				message: string,
			) {
				super(message);
			}
		}
		const err = new IntegrityAgentError("MODEL_ERROR", [], new APIError(402, "secret body"));
		expect(err.causeName).toBe("APIError");
		expect(err.causeStatus).toBe(402);
		expect(JSON.stringify({ name: err.causeName, status: err.causeStatus })).not.toContain(
			"secret body",
		);
	});

	it("is empty when there is no cause", () => {
		const err = new IntegrityAgentError("TIMEOUT");
		expect(err.causeName).toBeNull();
		expect(err.causeStatus).toBeNull();
	});
});
