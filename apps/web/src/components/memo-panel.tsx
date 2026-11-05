// Officer credit-memo panel (assist EN-01/02): draft from the case evidence,
// render sections/claims with citation chips, approve with an explicit
// confirm, and show the agent trace as metadata only. Hides itself while the
// assist flag is off (404); other errors surface via ErrorBox.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	apiErrorMessage,
	apiErrorWithCode,
	approveMemo,
	draftMemo,
	formatDateTime,
	formatMoney,
	listMemoArtifacts,
	productLabel,
	updateMemo,
	type CreditMemoContent,
	type MemoCitation,
} from "../lib/api";
import { asMemoContent } from "./memo-content";
import { TraceDetails } from "./trace-details";
import { ToolActivity } from "./tool-activity";
import { Button } from "./ui/button";
import { Card, EmptyState, ErrorBox, Skeleton, StatusBadge } from "./ui";

/** Human label for a source ref; document refs include their page when present. */
function sourceLabel(ref: string): string {
	const [type = ref, ...rest] = ref.split(":");
	if (type === "document") return `Document${rest[1] ? ` · ${rest[1]}` : ""}`;
	if (type === "policy_section") return `Policy ${rest[0] ?? ""}${rest[2] ? ` §${rest[2]}` : ""}`;
	if (type === "case_fact")
		return rest[1] ? `Case fact · ${rest[1].split(".").pop()}` : "Case fact";
	if (type === "score_reason")
		return rest[1] ? `Assessment factor · ${rest[1].replace(/_/g, " ")}` : "Assessment factor";
	if (type === "context_signal") return "Cash-flow signal";
	if (type === "external_evidence") return "External report";
	return type.replace(/_/g, " ").trim() || ref;
}

function CitationChip({
	citation,
	index,
	onSelect,
}: {
	citation: MemoCitation;
	index: number;
	onSelect: (citation: MemoCitation, index: number) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(citation, index)}
			aria-label={`Open memo source ${index}: ${sourceLabel(citation.ref)}`}
			title={`${sourceLabel(citation.ref)} — ${citation.quote.slice(0, 160)}`}
			className="mx-0.5 rounded border border-rule bg-card px-1 align-super text-sm font-medium text-red-link hover:underline"
		>
			[{index}]
		</button>
	);
}

function MemoCitationDialog({
	selected,
	onClose,
}: {
	selected: { citation: MemoCitation; index: number } | null;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (selected && !dialog.open) dialog.showModal();
		if (!selected && dialog.open) dialog.close();
	}, [selected]);
	return (
		<dialog
			ref={ref}
			onClose={onClose}
			aria-labelledby="memo-source-title"
			className="m-auto w-full max-w-sm rounded-sm border border-rule bg-card p-6 shadow-float backdrop:bg-ink/20"
		>
			{selected && (
				<>
					<div className="flex items-start justify-between gap-3">
						<div>
							<p className="overline">Source {selected.index}</p>
							<h3 id="memo-source-title" className="mt-1 text-lg leading-7 font-light text-ink">
								{sourceLabel(selected.citation.ref)}
							</h3>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onClose}
							aria-label="Close memo source"
						>
							✕
						</Button>
					</div>
					<p className="mt-3 text-xs break-all text-slate">{selected.citation.ref}</p>
					<blockquote className="mt-3 border-l-2 border-rule-strong pl-3 text-sm text-slate italic">
						“{selected.citation.quote}”
					</blockquote>
				</>
			)}
		</dialog>
	);
}

/** Unique sources actually cited by the memo, grouped for officer context. */
function evidenceBasis(content: CreditMemoContent): string | null {
	const refs = new Set(
		content.sections.flatMap((section) =>
			section.claims.flatMap((claim) => claim.citations.map((citation) => citation.ref)),
		),
	);
	const groups: Array<[string, string, string]> = [
		["case_fact", "case fact", "case facts"],
		["context_signal", "context signal", "context signals"],
		["policy_section", "policy section", "policy sections"],
		["document", "document", "document findings"],
		["external_evidence", "external report", "external reports"],
		["score_reason", "assessment factor", "assessment factors"],
	];
	const counts = new Map<string, number>();
	for (const ref of refs) {
		const type = ref.split(":")[0] ?? ref;
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const parts = groups
		.map(([type, singular, plural]) => {
			const count = counts.get(type) ?? 0;
			return count > 0 ? `${count} ${count === 1 ? singular : plural}` : null;
		})
		.filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

export function MemoPanel({
	applicationId,
	caseStatus,
	borrowerName,
	companyName,
	reference,
	product,
	amountCents,
	termMonths,
	documentsEnabled,
}: {
	applicationId: string;
	/** Draft/approve run only while the case awaits review. */
	caseStatus: string;
	borrowerName?: string;
	companyName?: string;
	reference: string;
	product: string;
	amountCents: number;
	termMonths: number;
	/** A re-draft is only offered when document evidence can be added. */
	documentsEnabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const [drafting, setDrafting] = useState(false);
	const [draftError, setDraftError] = useState("");
	const [acting, setActing] = useState(false);
	const [actionError, setActionError] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [editing, setEditing] = useState<CreditMemoContent | null>(null);
	const [selected, setSelected] = useState<{ citation: MemoCitation; index: number } | null>(null);

	const memos = useQuery({
		queryKey: ["memo", applicationId],
		queryFn: () => listMemoArtifacts(applicationId),
		retry: false,
	});
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ["memo", applicationId] });

	// Feature off → invisible; any other failure surfaces below.
	if (memos.isError && memos.error instanceof ApiError && memos.error.status === 404) {
		return null;
	}

	const artifact = memos.data?.items[0] ?? null;
	const content = artifact ? asMemoContent<CreditMemoContent>(artifact.content) : null;
	const canDraft = caseStatus === "pending_review";
	const isDraft = canDraft && artifact?.status === "draft";
	const preliminary = isDraft && artifact !== null && !artifact.documentDerived;
	const shown = editing ?? content;
	const citationNumbers = new Map<string, number>();
	for (const section of shown?.sections ?? []) {
		for (const claim of section.claims) {
			for (const citation of claim.citations) {
				if (!citationNumbers.has(citation.ref)) {
					citationNumbers.set(citation.ref, citationNumbers.size + 1);
				}
			}
		}
	}

	async function draft() {
		setDrafting(true);
		setDraftError("");
		try {
			await draftMemo(applicationId);
			await invalidate();
		} catch (err) {
			setDraftError(apiErrorWithCode(err));
		} finally {
			setDrafting(false);
		}
	}

	async function approve() {
		if (!artifact) return;
		setActing(true);
		setActionError("");
		try {
			await approveMemo(artifact.id, artifact.revision);
			setConfirming(false);
			await invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	function startEdit() {
		if (!content) return;
		setEditing(JSON.parse(JSON.stringify(content)) as CreditMemoContent);
		setActionError("");
	}

	function updateClaim(sectionIndex: number, claimIndex: number, text: string) {
		setEditing((current) => {
			if (!current) return current;
			const next = JSON.parse(JSON.stringify(current)) as CreditMemoContent;
			const claim = next.sections[sectionIndex]?.claims[claimIndex];
			if (claim) claim.text = text;
			return next;
		});
	}

	async function saveEdit() {
		if (!artifact || !editing) return;
		setActing(true);
		setActionError("");
		try {
			await updateMemo(artifact.id, artifact.revision, editing);
			setEditing(null);
			await invalidate();
		} catch (err) {
			setActionError(apiErrorWithCode(err));
		} finally {
			setActing(false);
		}
	}

	return (
		<Card
			title="Credit memo"
			actions={artifact ? <StatusBadge status={artifact.status} /> : undefined}
			className="border-0 bg-transparent p-0"
		>
			{drafting && <ToolActivity entries={[]} running pendingLabel="Reading case evidence…" />}
			{memos.isPending ? (
				<Skeleton label="Loading credit memo" />
			) : memos.isError ? (
				<ErrorBox message={apiErrorMessage(memos.error)} onRetry={() => void memos.refetch()} />
			) : !artifact || !content ? (
				<EmptyState
					title="No credit memo yet"
					hint={
						canDraft
							? "Draft one from the current case evidence — identical evidence replays the same draft."
							: "The case no longer awaits review, so no memo can be drafted."
					}
					action={
						canDraft ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void draft()}
								disabled={drafting}
							>
								{drafting ? "Drafting…" : "Draft memo"}
							</Button>
						) : undefined
					}
				/>
			) : (
				<div>
					<header className="border-b border-rule-strong pb-4">
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<h3 className="text-xl leading-7 font-light text-ink">
								{companyName || borrowerName || "Borrower"}
							</h3>
							<p className="text-xs text-slate">
								v{artifact.version} · r{artifact.revision}
							</p>
						</div>
						<dl className="mt-3 grid gap-x-6 gap-y-2 text-sm text-slate sm:grid-cols-2">
							<div>
								<dt className="inline font-medium text-ink">Reference: </dt>
								<dd className="inline">{reference}</dd>
							</div>
							<div>
								<dt className="inline font-medium text-ink">Product: </dt>
								<dd className="inline">{productLabel(product)}</dd>
							</div>
							<div>
								<dt className="inline font-medium text-ink">Requested: </dt>
								<dd className="inline tabular-nums">{formatMoney(amountCents)}</dd>
							</div>
							<div>
								<dt className="inline font-medium text-ink">Tenure: </dt>
								<dd className="inline tabular-nums">{termMonths} months</dd>
							</div>
							<div>
								<dt className="inline font-medium text-ink">Prepared: </dt>
								<dd className="inline">
									{formatDateTime(artifact.createdAt)}
									{artifact.agentTrace?.autoDrafted ? " · automatic draft" : ""}
								</dd>
							</div>
						</dl>
						{evidenceBasis(content) && (
							<p className="mt-2 text-xs text-slate">
								<span className="font-medium text-ink">Evidence basis: </span>
								{evidenceBasis(content)}
							</p>
						)}
						{artifact.agentTrace?.writer === "agent" && (
							<p className="mt-1 text-xs text-slate">
								Wording may be AI-polished; figures, security and policy are code-owned.
							</p>
						)}
					</header>
					{preliminary && (
						<div className="mt-4 flex flex-wrap items-center gap-2 rounded-sm border border-rule bg-warm px-3 py-2 text-sm text-slate">
							<span className="rounded bg-tag-blue px-1.5 py-0.5 font-medium text-ink">
								Preliminary
							</span>
							<span>
								Generated from case facts, score and policy — document evidence is not included yet.
							</span>
							{canDraft && documentsEnabled !== false && (
								<button
									type="button"
									onClick={() => void draft()}
									disabled={drafting}
									className="ml-auto font-medium text-ink hover:text-red-link hover:underline"
								>
									{drafting ? "Re-drafting…" : "Re-draft with full evidence"}
								</button>
							)}
						</div>
					)}
					<div className="mt-5 space-y-6">
						{shown?.sections.map((section, si) => (
							<section key={section.key} aria-label={section.title}>
								<h4 className="text-lg leading-7 font-light text-ink">{section.title}</h4>
								{section.notAvailable || section.claims.length === 0 ? (
									<p className="memo-prose mt-2 text-slate">Not available.</p>
								) : (
									<ul className="mt-2 space-y-3">
										{section.claims.map((claim, ci) => (
											<li key={`${section.key}-${ci}`} className="memo-prose text-ink">
												{editing ? (
													<textarea
														aria-label={`Edit claim ${ci + 1} in ${section.title}`}
														value={claim.text}
														onChange={(event) => updateClaim(si, ci, event.target.value)}
														rows={3}
														className="w-full rounded border border-rule-strong px-2 py-1 text-sm"
													/>
												) : (
													<p>
														{claim.text}{" "}
														{claim.citations.map((citation, j) => (
															<CitationChip
																key={`${citation.ref}-${j}`}
																citation={citation}
																index={citationNumbers.get(citation.ref) ?? j + 1}
																onSelect={(citation, index) => setSelected({ citation, index })}
															/>
														))}
													</p>
												)}
											</li>
										))}
									</ul>
								)}
							</section>
						))}
					</div>
					{content.openItems.length > 0 && (
						<div className="mt-6">
							<h4 className="text-lg leading-7 font-light text-ink">Open items</h4>
							<ul className="memo-prose mt-2 list-disc space-y-2 pl-5 text-slate">
								{content.openItems.map((item, i) => (
									<li key={i}>
										{item.text} <span className="font-mono text-xs text-slate">[{item.code}]</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{content.officerQuestions.length > 0 && (
						<div className="mt-6">
							<h4 className="text-lg leading-7 font-light text-ink">Officer questions</h4>
							<ul className="memo-prose mt-2 list-disc space-y-2 pl-5 text-slate">
								{content.officerQuestions.map((q) => (
									<li key={q}>{q}</li>
								))}
							</ul>
						</div>
					)}
					<TraceDetails
						trace={
							artifact.agentTrace
								? {
										writer: artifact.agentTrace.writer,
										model: artifact.agentTrace.model,
										promptVersion: artifact.agentTrace.promptVersion,
										agentVersion: artifact.agentTrace.agentVersion,
										evidenceHash: artifact.agentTrace.evidenceHash,
										steps: artifact.agentTrace.steps,
										toolCalls: artifact.agentTrace.toolCalls,
										sourceRefs: artifact.agentTrace.sourceRefs,
										repairAttempted: artifact.agentTrace.repairAttempted,
										repairSucceeded: artifact.agentTrace.repairSucceeded,
										fallbackReason: artifact.agentTrace.fallbackReason,
										inputTokens: artifact.agentTrace.inputTokens,
										outputTokens: artifact.agentTrace.outputTokens,
										latencyMs: artifact.agentTrace.latencyMs,
									}
								: null
						}
					/>
					{artifact.status === "approved" ? (
						<p className="mt-4 text-sm text-slate">
							Approved{artifact.approvedBy ? ` by ${artifact.approvedBy}` : ""}
							{artifact.approvedAt ? ` · ${formatDateTime(artifact.approvedAt)}` : ""}.
						</p>
					) : editing ? (
						<div className="mt-4 flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void saveEdit()}
								disabled={acting}
							>
								{acting ? "Saving…" : "Save changes"}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setEditing(null);
									setActionError("");
								}}
								disabled={acting}
							>
								Cancel edit
							</Button>
						</div>
					) : (
						<div className="mt-4 flex flex-wrap gap-2">
							{canDraft && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void draft()}
									disabled={drafting}
								>
									{drafting ? "Drafting…" : "Re-draft memo"}
								</Button>
							)}
							{isDraft && (
								<Button type="button" variant="outline" size="sm" onClick={startEdit}>
									Edit memo
								</Button>
							)}
							{isDraft &&
								(confirming ? (
									<>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => void approve()}
											disabled={acting}
										>
											{acting ? "Approving…" : "Confirm approval"}
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => {
												setConfirming(false);
												setActionError("");
											}}
											disabled={acting}
										>
											Cancel
										</Button>
									</>
								) : (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setConfirming(true)}
									>
										Approve memo
									</Button>
								))}
						</div>
					)}
					{draftError && (
						<div className="mt-3">
							<ErrorBox message={draftError} />
						</div>
					)}
					{actionError && (
						<div className="mt-3">
							<ErrorBox message={actionError} />
						</div>
					)}
				</div>
			)}
			<MemoCitationDialog selected={selected} onClose={() => setSelected(null)} />
		</Card>
	);
}
