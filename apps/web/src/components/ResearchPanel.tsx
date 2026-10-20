// Advisory agent research panel (Phase 2, SPEC §5/§8): officer-triggered
// cited brief. Polls until terminal; records one view after success;
// accept/reject is append-only. Only `verified` findings render. The panel
// hides itself while the feature flag is off and explains consent/empty/
// error states. It reports the accepted selection upward — the decision
// sends only the selection, never a browser-built bundle.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	ensureResearch,
	fetchResearch,
	formatDateOnly,
	formatDateTime,
	reviewResearchFinding,
	viewResearch,
	type ResearchAggregate,
	type ResearchEvidenceItem,
	type ResearchFindingItem,
	type ResearchSelection,
} from "../lib/api";
import { EmptyState, ErrorBox, Skeleton } from "./ui";

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Visible host + interstitial: never auto-opens, non-http(s) renders inert. */
function SourceLink({ url }: { url: string }) {
	const [confirm, setConfirm] = useState(false);
	const host = hostOf(url);
	if (!/^https?:\/\//i.test(url)) return <span className="text-gray-500">{host}</span>;
	if (!confirm) {
		return (
			<button
				type="button"
				onClick={() => setConfirm(true)}
				className="text-sm text-blue-700 hover:underline"
			>
				Open source · {host}
			</button>
		);
	}
	return (
		<span className="text-sm">
			Leave to {host}?{" "}
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				className="text-blue-700 hover:underline"
			>
				Open {host}
			</a>{" "}
			<button
				type="button"
				onClick={() => setConfirm(false)}
				className="text-gray-500 hover:underline"
			>
				Cancel
			</button>
		</span>
	);
}

function SourceCard({ evidence, support }: { evidence: ResearchEvidenceItem; support: string }) {
	return (
		<li className="rounded border border-gray-200 bg-gray-50 p-3">
			<p className="text-sm font-medium text-gray-800">{evidence.title || hostOf(evidence.url)}</p>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-gray-600 sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Publisher: </dt>
					<dd className="inline">{evidence.publisher}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Published: </dt>
					<dd className="inline">
						{evidence.publishedAt
							? `${formatDateOnly(evidence.publishedAt)} (${evidence.dateBasis ?? "unknown"})`
							: `undated (${evidence.dateBasis ?? "unknown"})`}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Retrieved: </dt>
					<dd className="inline">{formatDateTime(evidence.retrievedAt)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Tier: </dt>
					<dd className="inline">{evidence.sourceTier ?? "other"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Support: </dt>
					<dd className="inline">{support}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Host: </dt>
					<dd className="inline break-all">{hostOf(evidence.finalUrl || evidence.url)}</dd>
				</div>
			</dl>
			<blockquote className="mt-2 border-l-2 border-gray-300 pl-2 text-sm text-gray-700 italic">
				“{evidence.quote}”
			</blockquote>
			<div className="mt-1">
				<SourceLink url={evidence.finalUrl || evidence.url} />
			</div>
		</li>
	);
}

function entityLabel(entityMatch: unknown): string {
	if (typeof entityMatch !== "object" || entityMatch === null) return "—";
	const m = entityMatch as Record<string, unknown>;
	const idType = typeof m.identifierType === "string" ? m.identifierType : "?";
	const value = typeof m.value === "string" ? m.value : "?";
	const conf = typeof m.confidence === "string" ? ` (${m.confidence})` : "";
	return `${idType}: ${value}${conf}`;
}

function FindingCard({
	applicationId,
	finding,
}: {
	applicationId: string;
	finding: ResearchFindingItem;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<"accepted" | "rejected" | null>(null);
	const [error, setError] = useState("");
	const status = finding.reviewStatus ?? "pending";

	async function review(action: "accepted" | "rejected") {
		setBusy(action);
		setError("");
		try {
			await reviewResearchFinding(applicationId, finding.id, action);
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setError(apiErrorMessage(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<li className="rounded border border-gray-200 p-3">
			<p className="text-sm font-medium text-gray-900">{finding.claim}</p>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
				<div>
					<dt className="inline font-medium">Category: </dt>
					<dd className="inline">{finding.category}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Allegation: </dt>
					<dd className="inline">{finding.allegationStatus ?? "unknown"}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Entity: </dt>
					<dd className="inline">{entityLabel(finding.entityMatch)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Confidence: </dt>
					<dd className="inline">
						{finding.confidence ?? "?"}{" "}
						<details className="inline">
							<summary className="inline cursor-pointer text-blue-700 hover:underline">
								why?
							</summary>
							<p className="mt-1 max-w-full overflow-auto whitespace-pre-wrap break-words">
								{typeof finding.confidenceBasis === "string"
									? finding.confidenceBasis
									: JSON.stringify(finding.confidenceBasis ?? {}, null, 2)}
							</p>
						</details>
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Review: </dt>
					<dd className="inline" aria-live="polite">
						<span
							className={`rounded px-1.5 py-0.5 font-medium ${status === "accepted" ? "bg-green-100 text-green-800" : status === "rejected" ? "bg-gray-200 text-gray-700" : "bg-yellow-100 text-yellow-800"}`}
						>
							{status}
						</span>
					</dd>
				</div>
			</dl>
			{finding.whyItMatters && <p className="mt-1 text-sm text-gray-600">{finding.whyItMatters}</p>}
			{finding.evidence.length > 0 && (
				<ul className="mt-2 space-y-2">
					{finding.evidence.map((e) => (
						<SourceCard key={e.id} evidence={e} support={finding.support} />
					))}
				</ul>
			)}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-2 flex gap-2">
				<button
					type="button"
					onClick={() => void review("accepted")}
					disabled={busy !== null}
					aria-label={`Accept finding: ${finding.claim}`}
					className="rounded border border-green-600 px-3 py-1 text-sm text-green-800 disabled:opacity-50"
				>
					{busy === "accepted" ? "Accepting…" : "Accept"}
				</button>
				<button
					type="button"
					onClick={() => void review("rejected")}
					disabled={busy !== null}
					aria-label={`Reject finding: ${finding.claim}`}
					className="rounded border border-gray-400 px-3 py-1 text-sm text-gray-700 disabled:opacity-50"
				>
					{busy === "rejected" ? "Rejecting…" : "Reject"}
				</button>
			</div>
		</li>
	);
}

export function ResearchPanel({
	applicationId,
	caseStatus,
	aiResearchConsent,
	onSelectionChange,
}: {
	applicationId: string;
	/** Application status; Run is offered only while `pending_review`. */
	caseStatus?: string;
	/** Officer-visible consent flag; Run is hidden when consent is absent. */
	aiResearchConsent?: boolean | null;
	onSelectionChange: (selection: ResearchSelection | null) => void;
}) {
	const queryClient = useQueryClient();
	const viewedRun = useRef<string | null>(null);
	const [runError, setRunError] = useState("");
	const [running, setRunning] = useState(false);
	const [viewError, setViewError] = useState("");
	const [viewRetrying, setViewRetrying] = useState(false);

	const research = useQuery({
		queryKey: ["research", applicationId],
		queryFn: () => fetchResearch(applicationId),
		retry: false,
	});

	const data: ResearchAggregate | undefined = research.data;
	const status = data?.run.status;
	const { refetch } = research;

	// Run is offered only for undecided, consented cases: a decided case or
	// a missing consent shows explanatory copy instead of the button.
	const consentMissing = aiResearchConsent === false;
	const caseDecided = caseStatus !== undefined && caseStatus !== "pending_review";
	const canRun = !consentMissing && !caseDecided;

	// Poll while the run is active (function-form refetchInterval varies by
	// TanStack minor; an explicit interval is version-proof).
	useEffect(() => {
		if (status !== "queued" && status !== "running") return;
		const timer = setInterval(() => {
			void refetch();
		}, 2000);
		return () => clearInterval(timer);
	}, [status, refetch]);

	// Explicit view, once per run, after the panel has the succeeded brief.
	// The run is marked only after the view records: a failure leaves it
	// unmarked so a later refetch retries, and surfaces a bounded retry note.
	async function recordView(runId: string): Promise<void> {
		try {
			await viewResearch(applicationId, runId);
			viewedRun.current = runId;
			setViewError("");
		} catch {
			// Best-effort audit; the brief already renders. No automatic
			// retry is claimed — the officer retries explicitly, or a
			// refetch re-attempts once per fresh aggregate.
			setViewError("Research view was not recorded; refresh to retry.");
		}
	}

	useEffect(() => {
		if (status === "succeeded" && data && viewedRun.current !== data.run.id) {
			void recordView(data.run.id);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status, data, applicationId]);

	async function retryView(): Promise<void> {
		if (!data || status !== "succeeded") return;
		setViewRetrying(true);
		try {
			await recordView(data.run.id);
		} finally {
			setViewRetrying(false);
		}
	}

	// Accepted (verified-only) findings feed the decision selection.
	useEffect(() => {
		if (!data || status !== "succeeded") {
			onSelectionChange(null);
			return;
		}
		const accepted = (data.findings ?? [])
			.filter((f) => f.support === "verified" && (f.reviewStatus ?? "pending") === "accepted")
			.map((f) => f.id);
		onSelectionChange(
			accepted.length > 0 ? { agentRunId: data.run.id, acceptedFindingIds: accepted } : null,
		);
	}, [data, status, onSelectionChange]);

	async function run() {
		setRunning(true);
		setRunError("");
		try {
			await ensureResearch(applicationId);
			await queryClient.invalidateQueries({ queryKey: ["research", applicationId] });
		} catch (err) {
			setRunError(
				err instanceof ApiError ? `${err.code}: ${apiErrorMessage(err)}` : apiErrorMessage(err),
			);
		} finally {
			setRunning(false);
		}
	}

	// Feature disabled → hidden (SPEC AC-1). Applicants never reach here (403
	// at the gateway), so any other 404 means "no run yet".
	if (
		research.isError &&
		research.error instanceof ApiError &&
		research.error.status === 404 &&
		research.error.code === "RESEARCH_DISABLED"
	) {
		return null;
	}

	// A 403 consent error from any research call also hides Run: the case
	// props already say so, but the server is authoritative mid-flight.
	const consentBlocked =
		(research.isError &&
			research.error instanceof ApiError &&
			research.error.status === 403 &&
			research.error.code === "CONSENT_REQUIRED") ||
		runError.startsWith("CONSENT_REQUIRED:");
	const runAllowed = canRun && !consentBlocked;

	return (
		<section
			aria-label="Agent research"
			className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
		>
			<h2 className="text-base font-semibold">Agent research brief</h2>
			<p className="mt-0.5 text-xs text-gray-500">
				Advisory only — cited public sources for context. It never decides the case.
			</p>

			{research.isPending ? (
				<div className="mt-3">
					<Skeleton label="Loading research" />
				</div>
			) : research.isError ? (
				<div className="mt-3 space-y-3">
					{research.error instanceof ApiError && research.error.status === 404 ? (
						!runAllowed ? (
							<p className="mt-3 text-sm text-gray-600">
								{consentMissing
									? "Research is unavailable — AI research consent was not given for this case."
									: `This case is ${caseStatus} — research runs only while a case awaits review.`}
							</p>
						) : (
							<EmptyState
								title="No research run yet"
								hint="Run an advisory brief on cited public sources."
								action={
									<button
										type="button"
										onClick={() => void run()}
										disabled={running}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
									>
										{running ? "Starting…" : "Run research"}
									</button>
								}
							/>
						)
					) : (
						<ErrorBox
							message={apiErrorMessage(research.error)}
							onRetry={() => void research.refetch()}
						/>
					)}
					{runError && <ErrorBox message={runError} />}
				</div>
			) : status === "queued" || status === "running" ? (
				<div className="mt-3">
					<output className="block text-sm text-gray-600">
						Research {status}… checking cited public sources. This panel updates automatically.
					</output>
				</div>
			) : status === "failed" ? (
				<div className="mt-3 space-y-3">
					<ErrorBox
						message={`Research ${data?.run.errorCode ? `failed (${data.run.errorCode})` : "failed"}. The case remains fully decidable without it.`}
					/>
					{runAllowed ? (
						<button
							type="button"
							onClick={() => void run()}
							disabled={running}
							className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
						>
							{running ? "Retrying…" : "Retry research"}
						</button>
					) : (
						<p className="text-sm text-gray-600">
							{consentMissing || consentBlocked
								? "Research is unavailable — AI research consent was not given for this case."
								: `This case is ${caseStatus} — research runs only while a case awaits review.`}
						</p>
					)}
					{runError && <ErrorBox message={runError} />}
				</div>
			) : (
				<div className="mt-3 space-y-4">
					{data?.brief?.summary ? (
						<p className="text-sm text-gray-800">{data.brief.summary}</p>
					) : (
						<p className="text-sm text-gray-600">No summary — nothing supported was found.</p>
					)}

					{(() => {
						const verified = (data?.findings ?? []).filter((f) => f.support === "verified");
						return verified.length === 0 ? (
							<EmptyState
								title="No supported findings"
								hint={`Checked ${data?.usage?.searches ?? 0} searches across public sources; nothing met the citation bar.`}
							/>
						) : (
							<ul className="space-y-3">
								{verified.map((f) => (
									<FindingCard key={f.id} applicationId={applicationId} finding={f} />
								))}
							</ul>
						);
					})()}

					{(data?.brief?.contradictions?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Contradictions</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.contradictions?.map((c) => (
									<li key={c.description}>{c.description}</li>
								))}
							</ul>
						</div>
					)}
					{(data?.brief?.unknowns?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Unknowns</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.unknowns?.map((u) => (
									<li key={u}>{u}</li>
								))}
							</ul>
						</div>
					)}
					{(data?.brief?.questionsForOfficer?.length ?? 0) > 0 && (
						<div>
							<h3 className="text-sm font-semibold">Questions for the officer</h3>
							<ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
								{data?.brief?.questionsForOfficer?.map((q) => (
									<li key={q}>{q}</li>
								))}
							</ul>
						</div>
					)}

					<p className="text-xs text-gray-500">
						What was searched: {data?.usage?.searches ?? 0} queries · {data?.usage?.extracts ?? 0}{" "}
						sources read · model {data?.run.model ?? "?"} · as of {formatDateOnly(data?.run.asOf)} ·
						run {shortId(data?.run.id ?? "")}
						{data?.run.observability === "degraded" ? " · observability degraded" : ""}.
					</p>
					{viewError && (
						<p className="text-xs text-gray-500">
							{viewError}{" "}
							<button
								type="button"
								onClick={() => void retryView()}
								disabled={viewRetrying}
								className="text-blue-700 hover:underline disabled:opacity-50"
							>
								{viewRetrying ? "Retrying…" : "Retry now"}
							</button>
						</p>
					)}
				</div>
			)}
		</section>
	);
}
