// Officer case detail: PageHead, fact strip, decision banner, fraud warning,
// 6/6 grid with application/credit/policy/verification/documents/integrity in
// the case column and a tabbed assist workspace in the secondary column.
// The timeline lives in a right-hand sheet; the officer decision sits below
// both columns. Reuses the shared panels unchanged.
import { reasonText } from "@credit/core/browser";
import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useState } from "react";
import { CaseAssistantPanel } from "../case-assistant-panel";
import { DecisionPanel } from "../decision-panel";
import { DocumentPanel } from "../document-panel";
import { IntegrityPanel } from "../integrity-panel";
import { MemoPanel } from "../memo-panel";
import { PolicyExceptionPanel } from "../policy-exception-panel";
import { ResearchPanel } from "../research-panel";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { ButtonLink } from "../ubs/button-link";
import {
	BarRow,
	CodeTag,
	Meter,
	Money,
	Overline,
	PageHead,
	Panel,
	StatusBadge,
	Tabs,
	Tag,
} from "../ubs";
import {
	actionLabel,
	fieldLabel,
	formatDate,
	formatDateTime,
	formatFieldValue,
	formatMoney,
	formatTime,
	formatWait,
	productLabel,
	typeLabel,
	type CaseDetail,
	type ResearchSelection,
} from "../../lib/api";

type AssistTab = "brief" | "memo" | "policy" | "ask";

/** Queue risk bands (spec §1): low ≥ 760, medium ≥ 640, high below; missing is medium. */
function riskOf(score: number | null | undefined): "low" | "medium" | "high" {
	if (score === null || score === undefined) return "medium";
	if (score >= 760) return "low";
	if (score >= 640) return "medium";
	return "high";
}

function clientNameOf(data: CaseDetail): string {
	const business = (data.application.business ?? null) as Record<string, unknown> | null;
	const identity = (data.application.identity ?? {}) as Record<string, unknown>;
	if (
		business !== null &&
		typeof business.companyName === "string" &&
		business.companyName !== ""
	) {
		return business.companyName;
	}
	if (typeof identity.fullName === "string" && identity.fullName !== "") return identity.fullName;
	return data.application.reference;
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="py-1">
			<dt className="text-xs text-slate">{label}</dt>
			<dd className="mt-0.5 text-sm font-medium break-words text-ink">{value}</dd>
		</div>
	);
}

function FraudWarning({ data }: { data: CaseDetail }) {
	const fraud = data.fraudReview;
	if (!fraud) return null;
	return (
		<div
			role="alert"
			className="mt-8 border border-warning bg-tag-amber px-4 py-3 text-sm text-warning-ink"
		>
			<p>
				<span className="font-medium">Open fraud review ({fraud.severity}):</span>{" "}
				<span className="font-mono text-xs">{fraud.reasonCode}</span> · {fraud.status}. Review it
				before deciding — the decision path stays open.
			</p>
			<p className="mt-2">
				<Link
					to="/officer/fraud-review/$id"
					params={{ id: fraud.id }}
					className="inline-flex items-center gap-1 font-medium text-red-link hover:underline"
				>
					Open fraud review
				</Link>
			</p>
		</div>
	);
}

function DecisionBanner({ data }: { data: CaseDetail }) {
	const decision = data.decision;
	if (!decision) return null;
	const approved = decision.outcome === "approved";
	return (
		<output
			id="decision-record"
			className="mt-8 flex flex-wrap items-center gap-3 border border-rule bg-raised px-4 py-3 text-sm"
		>
			<Tag tone={approved ? "success" : "danger"}>{approved ? "Approved" : "Declined"}</Tag>
			<p className="text-ink">
				Decision: {decision.outcome} ({decision.decidedBy})
				{approved &&
				decision.approvedAmountCents !== null &&
				decision.approvedAmountCents !== undefined
					? ` · ${formatMoney(decision.approvedAmountCents)} over ${decision.termMonths} months`
					: ""}
				{approved && decision.rateBps !== null && decision.rateBps !== undefined
					? ` at ${(decision.rateBps / 100).toFixed(2)}%`
					: ""}
				{!approved && decision.notes ? ` · ${decision.notes}` : ""} ·{" "}
				{formatDateTime(decision.decidedAt)}
			</p>
		</output>
	);
}

function FactStrip({ data }: { data: CaseDetail }) {
	const app = data.application;
	const score = data.score?.score ?? null;
	const grade = data.score?.grade ?? null;
	const aff = data.score?.affordability;
	const isSme = app.type === "sme";
	const ratio = isSme
		? aff?.dscr !== undefined
			? `${aff.dscr.toFixed(2)}×`
			: "—"
		: aff?.dti !== undefined
			? `${(aff.dti * 100).toFixed(2)}%`
			: "—";
	const [nowMs] = useState(() => Date.now());
	const submittedMs = app.submittedAt ? new Date(app.submittedAt).getTime() : Number.NaN;
	const wait =
		Number.isNaN(submittedMs) || Number.isNaN(nowMs)
			? "—"
			: formatWait(Math.max(0, nowMs - submittedMs));
	return (
		<section
			aria-label="Case facts"
			className="grid grid-cols-2 gap-6 border-y border-rule py-6 sm:grid-cols-4 lg:grid-cols-7"
		>
			<div>
				<Overline>Requested</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{formatMoney(app.amountCents)}</p>
			</div>
			<div>
				<Overline>Term</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{app.termMonths} months</p>
			</div>
			<div>
				<Overline>Score/Grade</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">
					{score === null ? "—" : `${score}${grade ? ` / ${grade}` : ""}`}
				</p>
			</div>
			<div>
				<Overline>{isSme ? "DSCR" : "DTI"}</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{ratio}</p>
			</div>
			<div>
				<Overline>Risk</Overline>
				<p className="mt-2">
					<StatusBadge status={riskOf(score)} />
				</p>
			</div>
			<div>
				<Overline>Wait</Overline>
				<p className="mt-2 text-lg font-light text-ink tabular">{wait}</p>
			</div>
			<div>
				<Overline>Status</Overline>
				<p className="mt-2">
					<StatusBadge status={app.status} />
				</p>
			</div>
		</section>
	);
}

function CreditSnapshot({ data }: { data: CaseDetail }) {
	const app = data.application;
	const business = (app.business ?? {}) as Record<string, unknown>;
	const financial = (app.financial ?? {}) as Record<string, unknown>;
	const collateral = (business.collateral ?? null) as Record<string, unknown> | null;
	const aff = data.score?.affordability;
	const ratio = (value: unknown): string | null =>
		typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}×` : null;
	const rows: Array<[string, React.ReactNode]> = [];
	if (app.type === "sme") {
		const leverage = ratio(business.leverageRatio);
		const current = ratio(business.currentRatio);
		if (leverage) rows.push(["Leverage", leverage]);
		if (current) rows.push(["Current ratio", current]);
	} else {
		if (typeof financial.monthlyIncomeCents === "number") {
			rows.push(["Monthly income", formatMoney(financial.monthlyIncomeCents)]);
		}
		if (typeof financial.existingDebtCents === "number") {
			rows.push(["Existing debt", formatMoney(financial.existingDebtCents)]);
		}
		if (typeof financial.employmentStatus === "string") {
			rows.push(["Employment", formatFieldValue("employmentStatus", financial.employmentStatus)]);
		}
		if (aff?.dti !== undefined) rows.push(["DTI", `${(aff.dti * 100).toFixed(2)}%`]);
	}
	if (collateral === null) {
		rows.push(["Security", "Not recorded"]);
	} else if (collateral.hasCollateral === true) {
		rows.push([
			"Security",
			typeof collateral.valueCents === "number"
				? `${formatMoney(collateral.valueCents)} recorded`
				: "Secured",
		]);
	} else {
		rows.push(["Security", "Unsecured"]);
	}
	if (
		typeof business.existingFacilitiesSummary === "string" &&
		business.existingFacilitiesSummary.trim() !== ""
	) {
		rows.push(["Existing facilities", business.existingFacilitiesSummary]);
	}
	if (rows.length === 0) return null;
	return (
		<Panel title="Credit snapshot" outline>
			<dl className="grid gap-4 sm:grid-cols-2">
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt className="text-xs text-slate">{label}</dt>
						<dd className="mt-1 text-sm font-medium break-words text-ink tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
		</Panel>
	);
}

function ApplicationPanel({ data }: { data: CaseDetail }) {
	const app = data.application;
	const identity = (app.identity ?? {}) as Record<string, unknown>;
	const business = (app.business ?? null) as Record<string, unknown> | null;
	const aff = data.score?.affordability;
	const dti = aff?.dti !== undefined ? `${(aff.dti * 100).toFixed(2)}%` : null;
	const rows: Array<[string, React.ReactNode]> = [
		["Applicant", (identity.fullName as string) ?? "—"],
	];
	if (business?.companyName) rows.push(["Company", String(business.companyName)]);
	rows.push(["Segment", typeLabel(app.type)]);
	rows.push(["Product", productLabel(app.product)]);
	rows.push(["Purpose", app.purpose]);
	rows.push(["Submitted", formatDate(app.submittedAt)]);
	rows.push(["Location", identity.city ? String(identity.city) : "—"]);
	if (business?.registrationNumber)
		rows.push(["Registration number", String(business.registrationNumber)]);
	if (business?.industry) rows.push(["Industry", formatFieldValue("industry", business.industry)]);
	if (business?.employees !== undefined && business.employees !== null)
		rows.push(["Employees", String(business.employees)]);
	if (business?.yearsTrading !== undefined && business.yearsTrading !== null)
		rows.push(["Trading history", `${String(business.yearsTrading)} years`]);
	if (typeof business?.annualRevenueCents === "number")
		rows.push(["Annual revenue", formatMoney(business.annualRevenueCents as number)]);
	if (typeof business?.monthlyFcfCents === "number")
		rows.push(["Monthly free cash flow", formatMoney(business.monthlyFcfCents as number)]);
	if (typeof business?.existingDebtServiceCents === "number")
		rows.push([
			"Existing debt service",
			`${formatMoney(business.existingDebtServiceCents as number)} / month`,
		]);
	if (dti) rows.push(["DTI", dti]);
	return (
		<Panel title="Application" outline>
			<dl className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
				{rows.map(([label, value]) => (
					<Kv key={label} label={label} value={value} />
				))}
			</dl>
		</Panel>
	);
}

function CreditPanel({ data }: { data: CaseDetail }) {
	const score = data.score;
	const aff = score?.affordability;
	return (
		<Panel
			title="Credit assessment"
			action={
				score ? <span className="text-xs text-slate">Model {score.modelVersion}</span> : undefined
			}
			outline
		>
			{!score ? (
				<p className="text-sm text-slate">Not scored yet.</p>
			) : (
				<div className="grid gap-6 xl:grid-cols-5">
					<div className="xl:col-span-2">
						<div className="flex flex-wrap items-end justify-between gap-4">
							<div>
								<p className="text-4xl leading-none font-light text-ink tabular">{score.score}</p>
								<p className="mt-1 text-sm text-slate">Grade {score.grade}</p>
							</div>
							<div className="text-right text-sm text-slate">
								{aff?.dscr !== undefined && <p>DSCR {aff.dscr.toFixed(2)}×</p>}
								{aff?.dti !== undefined && <p>DTI {(aff.dti * 100).toFixed(2)}%</p>}
							</div>
						</div>
						<div className="mt-3">
							<Meter
								value={score.score - 300}
								max={550}
								tone={score.score >= 720 ? "success" : score.score >= 640 ? "warning" : "danger"}
								label={`Score ${score.score}`}
							/>
							<div className="mt-1 flex justify-between text-xs text-slate tabular">
								<span>300</span>
								<span>580</span>
								<span>650</span>
								<span>720</span>
								<span>850</span>
							</div>
						</div>
						{aff?.newPaymentCents !== undefined && (
							<p className="mt-3 text-sm text-slate">
								New payment <Money cents={aff.newPaymentCents} />
							</p>
						)}
					</div>
					<ul className="space-y-3 xl:col-span-3">
						{[...score.factors]
							.sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
							.slice(0, 5)
							.map((f) => (
								<li key={f.code}>
									<BarRow
										label={`${f.label} (${f.code})`}
										value={f.points > 0 ? `+${f.points}` : `${f.points}`}
										pct={Math.min(100, Math.abs(f.points))}
										color={f.points >= 0 ? "var(--success)" : "var(--danger)"}
									/>
								</li>
							))}
					</ul>
				</div>
			)}
		</Panel>
	);
}

function PolicyPanel({ data }: { data: CaseDetail }) {
	const policy = data.policyEvaluation;
	return (
		<Panel
			title="Policy check"
			action={
				<Link
					to="/officer/policies"
					className="inline-flex items-center gap-1 text-sm font-medium text-red-link hover:underline"
				>
					Open policy
				</Link>
			}
			outline
		>
			{!policy ? (
				<p className="text-sm text-slate">No policy outcome.</p>
			) : (
				<div>
					<p className="text-sm text-ink">
						Outcome: <CodeTag code={policy.outcome} /> · max <Money cents={policy.maxAmountCents} />{" "}
						· {policy.policyVersion}
					</p>
					<ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
						{policy.reasons.map((r) => (
							<li key={r.code}>
								<CodeTag code={r.code} /> — {reasonText(r.code)}
							</li>
						))}
					</ul>
				</div>
			)}
		</Panel>
	);
}

function VerificationDocuments({ data }: { data: CaseDetail }) {
	return (
		<div className="grid gap-8 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
			<Panel title="Verification" outline>
				{data.checks.length === 0 ? (
					<p className="text-sm text-slate">No checks yet.</p>
				) : (
					<ul className="space-y-1.5 text-sm">
						{data.checks.map((c) => (
							<li key={c.type} className="flex items-center gap-2">
								<StatusBadge status={c.status} />
								<span className="text-ink">{c.type}</span>
							</li>
						))}
					</ul>
				)}
			</Panel>
			<Panel
				title="Evidence files"
				action={<span className="text-xs text-slate">{data.documents.length} files</span>}
				outline
			>
				{data.documents.length === 0 ? (
					<p className="text-sm text-slate">No documents.</p>
				) : (
					<ul className="space-y-1.5 text-sm">
						{data.documents.map((d) => (
							<li key={d.kind} className="flex items-center gap-2">
								<StatusBadge status={d.status} />
								<span className="text-ink">{fieldLabel(d.kind)}</span>
								{d.note && <span className="text-slate">— {d.note}</span>}
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

function TimelineEntries({ data }: { data: CaseDetail }) {
	const hidden = /^(access\.|context\.read|policy_exception\.viewed)/;
	const filtered = data.timeline.filter((e) => !hidden.test(e.action ?? ""));
	const visible = filtered.slice(0, 20);
	if (visible.length === 0) return <p className="text-sm text-slate">No activity yet.</p>;

	const groups = new Map<string, typeof visible>();
	for (const entry of visible) {
		const day = formatDate(entry.at);
		const entries = groups.get(day) ?? [];
		entries.push(entry);
		groups.set(day, entries);
	}

	return (
		<div>
			{[...groups.entries()].map(([day, entries]) => (
				<section key={day} className="mt-4 first:mt-0">
					<h3 className="overline">{day}</h3>
					<ol className="mt-2 divide-y divide-rule text-sm">
						{entries.map((e, index) => (
							<li
								// Audit rows can share the same millisecond and action
								// (e.g. several document.reused); index keeps them keyed.
								key={`${e.at}-${e.kind ?? "audit"}-${e.action ?? e.type ?? ""}-${index}`}
								className="flex flex-wrap gap-x-3 gap-y-0.5 py-2"
							>
								<span className="tabular text-slate">{formatTime(e.at)}</span>
								<span className="font-medium text-ink">
									{actionLabel(e.kind === "feed" ? e.type : e.action)}
								</span>
								{e.kind === "feed" && e.message && <span className="text-slate">{e.message}</span>}
							</li>
						))}
					</ol>
				</section>
			))}
			{visible.length < filtered.length && (
				<p className="mt-3 text-xs text-slate">
					Showing the latest {visible.length} business events.
				</p>
			)}
		</div>
	);
}

function TimelineSheet({
	open,
	onOpenChange,
	data,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	data: CaseDetail;
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="flex w-full flex-col overflow-hidden sm:max-w-110">
				<SheetHeader className="mr-8 flex-none">
					<Overline>Case activity</Overline>
					<SheetTitle>Case timeline</SheetTitle>
					<SheetDescription>
						Business events, newest first. Access checks and context reads are hidden.
					</SheetDescription>
				</SheetHeader>
				<div className="mt-4 min-h-0 flex-1 overflow-y-auto">
					<TimelineEntries data={data} />
				</div>
			</SheetContent>
		</Sheet>
	);
}

export function OfficerCaseView({
	data,
	researchSelection,
	onResearchSelection,
	onDecided,
}: {
	data: CaseDetail;
	researchSelection: ResearchSelection | null;
	onResearchSelection: (selection: ResearchSelection | null) => void;
	onDecided: () => void;
}) {
	const app = data.application;
	const decided = app.status !== "pending_review";
	const [assistTab, setAssistTab] = useState<AssistTab>("brief");
	const [timelineOpen, setTimelineOpen] = useState(false);
	return (
		<>
			<PageHead
				title={clientNameOf(data)}
				subtitle={`${app.reference} · ${formatMoney(app.amountCents)} requested · ${app.termMonths} months · ${app.purpose}`}
				actions={
					<>
						<StatusBadge status={app.status} />
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setTimelineOpen(true)}
							aria-haspopup="dialog"
							aria-expanded={timelineOpen}
						>
							<Clock className="size-4" strokeWidth={1.5} aria-hidden="true" />
							Show case timeline
						</Button>
						{!decided && (
							<a
								href="#officer-decision"
								className="text-sm font-medium text-red-link hover:underline"
							>
								Record decision
							</a>
						)}
						<Link
							to="/officer/review"
							className="inline-flex items-center gap-1 text-sm font-medium text-red-link hover:underline"
						>
							Back to queue
						</Link>
					</>
				}
			/>

			<FactStrip data={data} />
			<DecisionBanner data={data} />
			<FraudWarning data={data} />

			<div className="mt-8 grid gap-10 lg:grid-cols-2">
				<div className="min-w-0 space-y-6">
					<CreditSnapshot data={data} />
					<ApplicationPanel data={data} />
					<CreditPanel data={data} />
					<PolicyPanel data={data} />
					<VerificationDocuments data={data} />
					<DocumentPanel
						applicationId={app.id}
						mode="officer"
						documentsEnabled={app.documentsEnabled ?? false}
						documentProcessingConsent={app.documentProcessingConsent}
					/>
					<IntegrityPanel applicationId={app.id} />
				</div>
				<aside className="min-w-0">
					<section
						aria-label="AI case assist"
						className="assist-pane flex flex-col rounded-sm bg-warm p-6 lg:overflow-hidden"
					>
						<div className="flex-none">
							<div className="mb-2 flex items-start justify-between gap-4">
								<div>
									<Overline>Advisory</Overline>
									<div className="mt-1 flex items-center gap-3">
										<span className="h-1 w-10 bg-red" aria-hidden="true" />
										<h2 className="text-2xl leading-8 font-light text-ink">Case assist</h2>
									</div>
								</div>
								<Tag tone="neutral">AI</Tag>
							</div>
							<p className="mb-4 text-sm text-slate">Evidence only — the decision is yours.</p>
							<Tabs
								ariaLabel="Case assist"
								items={[
									{ value: "brief", label: "Brief" },
									{ value: "memo", label: "Memo" },
									{ value: "policy", label: "Policy" },
									{ value: "ask", label: "Ask" },
								]}
								value={assistTab}
								onChange={setAssistTab}
							/>
						</div>
						<div className="mt-6 min-h-0 lg:flex-1 lg:overflow-y-auto">
							<div hidden={assistTab !== "brief"}>
								<ResearchPanel
									applicationId={app.id}
									caseStatus={app.status}
									aiResearchConsent={app.aiResearchConsent}
									onSelectionChange={onResearchSelection}
								/>
							</div>
							<div hidden={assistTab !== "memo"}>
								<MemoPanel
									applicationId={app.id}
									caseStatus={app.status}
									borrowerName={
										((app.identity ?? {}) as Record<string, unknown>).fullName as string | undefined
									}
									companyName={
										((app.business ?? {}) as Record<string, unknown>).companyName as
											| string
											| undefined
									}
									reference={app.reference}
									product={app.product}
									amountCents={app.amountCents}
									termMonths={app.termMonths}
									documentsEnabled={app.documentsEnabled ?? false}
								/>
							</div>
							<div hidden={assistTab !== "policy"}>
								<PolicyExceptionPanel applicationId={app.id} caseStatus={app.status} />
							</div>
							<div hidden={assistTab !== "ask"}>
								<CaseAssistantPanel
									key={app.id}
									applicationId={app.id}
									contextAnalysisConsent={app.contextAnalysisConsent}
								/>
							</div>
						</div>
					</section>
				</aside>
			</div>

			<div id="officer-decision" className="mt-12 border-t border-rule-illustrative pt-6">
				<div className="max-w-3xl">
					{decided ? (
						<Panel title="Officer decision" outline>
							{data.decision ? (
								<>
									<div className="flex flex-wrap items-center gap-3">
										<StatusBadge status={data.decision.outcome} />
										<p className="text-sm text-ink">
											Decided by {data.decision.decidedBy} ·{" "}
											{formatDateTime(data.decision.decidedAt)}
										</p>
									</div>
									<dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
										{data.decision.approvedAmountCents !== null && (
											<div>
												<dt className="inline font-medium">Amount: </dt>
												<dd className="inline tabular-nums">
													{formatMoney(data.decision.approvedAmountCents)}
												</dd>
											</div>
										)}
										{data.decision.termMonths !== null && (
											<div>
												<dt className="inline font-medium">Duration: </dt>
												<dd className="inline tabular-nums">{data.decision.termMonths} months</dd>
											</div>
										)}
										{data.decision.rateBps !== null && (
											<div>
												<dt className="inline font-medium">Rate: </dt>
												<dd className="inline tabular-nums">
													{(data.decision.rateBps / 100).toFixed(2)}%
												</dd>
											</div>
										)}
									</dl>
									{data.decision.notes && (
										<p className="mt-3 text-sm text-ink">{data.decision.notes}</p>
									)}
								</>
							) : (
								<p className="text-sm text-slate">Case is {app.status} — no decision needed.</p>
							)}
							{data.loan && (
								<p className="mt-3">
									<ButtonLink to="/officer/portfolio" variant="link">
										View portfolio
									</ButtonLink>
								</p>
							)}
						</Panel>
					) : (
						<DecisionPanel
							applicationId={app.id}
							requestedAmountCents={app.amountCents}
							requestedTermMonths={app.termMonths}
							maxAmountCents={data.policyEvaluation?.maxAmountCents ?? app.amountCents}
							product={app.product}
							researchSelection={researchSelection}
							onResearchStale={() => onResearchSelection(null)}
							onDecided={onDecided}
						/>
					)}
				</div>
			</div>

			<TimelineSheet open={timelineOpen} onOpenChange={setTimelineOpen} data={data} />
		</>
	);
}
