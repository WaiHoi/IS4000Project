// Research disabled state (AC-1/AC-2): with the feature flags off, the
// officer case page hides the research panel, officer research calls 404,
// and applicants get 403 on every research route. A live fictional run is
// intentionally not covered here: it needs model/search keys that CI does
// not have (integration tests cover the run path with fakes).
import { expect, test } from "@playwright/test";
import { Api, gotoHydrated, uiLogin } from "./helpers.js";

test("research disabled: panel hidden, officer 404, applicant 403", async ({ page }) => {
	const applicant = new Api();
	await applicant.login("lena@bakery.example");
	const submitted = await applicant.post<{ id: string; reference: string }>("/api/applications", {
		type: "individual",
		product: "personal_loan",
		amountCents: 1_200_000,
		termMonths: 48,
		purpose: "Home renovation",
		consents: [true, true, true],
		aiResearchConsent: false,
		identity: {
			fullName: "Lena Bakery",
			dob: "1990-05-01",
			nationalId: "LENA0001",
			email: "lena@bakery.example",
			phone: "+1-555-0100",
			address: "1 Demo Street",
			city: "Demo City",
		},
		individual: {
			employmentStatus: "employed",
			employerName: "Demo Bakery",
			employmentYears: 5,
			monthlyIncomeCents: 420_000,
			existingDebtCents: 61_000,
			bankRelationshipYears: 3,
		},
	});
	const appId = submitted.id;

	// Applicants 403 on every research route (gateway officer guard).
	await expect(applicant.post(`/api/review/${appId}/research`)).rejects.toMatchObject({
		status: 403,
	});
	await expect(applicant.get(`/api/review/${appId}/research`)).rejects.toMatchObject({
		status: 403,
	});

	// Officers 404 while the flags are off (feature disabled, not forbidden).
	const officer = new Api();
	await officer.login("officer@example.com");
	await expect(officer.post(`/api/review/${appId}/research`)).rejects.toMatchObject({
		status: 404,
		code: "RESEARCH_DISABLED",
	});
	await expect(officer.get(`/api/review/${appId}/research`)).rejects.toMatchObject({
		status: 404,
		code: "RESEARCH_DISABLED",
	});

	// The case page hides the panel entirely (no placeholder, no run button).
	await uiLogin(page, "officer@example.com");
	await gotoHydrated(page, `/officer/review/${appId}`);
	await expect(page.getByText(submitted.reference).first()).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('section[aria-label="Agent research"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Run research" })).toHaveCount(0);
});
