// Officer evidence workspace: one merged panel for documents and document
// integrity. Rows are driven by the documents API and joined with the
// integrity read by document id; findings, field candidates and technical
// detail live behind one expandable row instead of two duplicate lists.
//
// Advisory/deterministic boundary: this component only presents evidence and
// officer actions. It never scores, decides, prices, sets terms, or books.
// Stored document text is rendered as React text nodes; nothing
// document-derived reaches console, logs, or URLs.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronRight, FileText, IdCard, Landmark, ReceiptText } from "lucide-react";
import { cn } from "cn";
import { Button } from "./ui/button";
import {
	ApiError,
	claimDocuments,
	createChaseDraft,
	fetchCrosscheck,
	fetchDocumentFiles,
	fetchIntegrityPanel,
	fetchIntegrityRun,
	fieldLabel,
	formatDate,
	requestIntegrityAnalysis,
	runCrosscheck,
	type ChaseDraft,
	type DocumentCrosscheck,
	type DocumentFile,
	type IntegrityDocumentPanel,
	type IntegrityPanel as IntegrityPanelData,
	type IntegritySeverity,
} from "../lib/api";
import { clean, friendlyMessage, shortId } from "../lib/format";
import { ErrorBox, Panel, StatusBadge, Tag, Tabs } from "./ubs";
import { TraceDetails } from "./trace-details";
import { DocumentActions, FindingItem, UploadForm, ocrLabel } from "./document-panel";
import {
	CandidateRow,
	ConsistencyItem,
	FingerprintDetails,
	FlagControls,
	SignalChips,
} from "./integrity-panel";

type DetailTab = "findings" | "fields" | "details";
type CrosscheckFinding = DocumentCrosscheck["findings"][number];

const SEVERITY_ORDER: Record<IntegritySeverity, number> = { high: 0, medium: 1, low: 2 };

function focusCrosscheck() {
	const section = document.getElementById("evidence-crosscheck");
	section?.scrollIntoView({ block: "start" });
	section?.focus();
}

interface AttentionItem {
	key: string;
	docId: string | null;
	severity: IntegritySeverity;
	priority: number;
	action: "review" | "open";
	title: string;
	detail: string;
}

function DocIcon({ kind }: { kind: string }) {
	const props = { className: "size-4 shrink-0 text-slate", strokeWidth: 1.5 };
	if (kind === "id") return <IdCard {...props} aria-hidden="true" />;
	if (kind === "bank_statement") return <Landmark {...props} aria-hidden="true" />;
	if (kind === "financial_statements" || kind === "payslip") {
		return <ReceiptText {...props} aria-hidden="true" />;
	}
	return <FileText {...props} aria-hidden="true" />;
}

function OpenReviewBanner({ integrity }: { integrity: IntegrityPanelData }) {
	const review = integrity.openReview;
	if (review === null) return null;
	const analysis = integrity.latestAnalysis;
	return (
		<p className="mt-3 rounded-sm border border-warning bg-tag-amber px-3 py-2 text-sm text-warning-ink">
			Open fraud review ({clean(review.reasonCode)} · {clean(review.status)}):{" "}
			<Link
				to="/officer/fraud-review/$id"
				params={{ id: review.id }}
				className="font-medium text-red-link hover:underline"
			>
				open review
			</Link>
			{analysis?.status === "queued" || analysis?.status === "running" ? (
				<span aria-live="polite"> · Integrity brief in progress</span>
			) : analysis?.status === "failed" ? (
				<span> · Brief unavailable - retry from the review</span>
			) : null}
		</p>
	);
}

function useIntegrity(applicationId: string) {
	return useQuery({
		queryKey: ["integrity", applicationId],
		queryFn: () => fetchIntegrityPanel(applicationId),
		retry: false,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data?.openReview) return false;
			const status = data.latestAnalysis?.status;
			return status === "queued" || status === "running" ? 3000 : false;
		},
	});
}

function isActionableSignal(code: string): boolean {
	return (
		code !== "crosscheck_mismatch" &&
		code !== "consistency_candidate" &&
		code !== "metadata_unknown"
	);
}

function issueCount(
	integrityDoc: IntegrityDocumentPanel | undefined,
	crosscheckFindings: CrosscheckFinding[],
): number {
	const coveredFields = new Set(
		(integrityDoc?.consistency ?? [])
			.filter((item) => item.findingState !== "match")
			.map((item) => item.field),
	);
	const uncoveredCrosscheck = crosscheckFindings.filter(
		(finding) => !coveredFields.has(finding.field),
	).length;
	if (integrityDoc === undefined) return uncoveredCrosscheck;
	return (
		integrityDoc.consistency.filter((item) => item.findingState !== "match").length +
		integrityDoc.signals.filter((signal) => isActionableSignal(signal.code)).length +
		uncoveredCrosscheck
	);
}

function buildAttention(
	integrityDocs: Map<string, IntegrityDocumentPanel>,
	crosscheckFindings: CrosscheckFinding[],
	integrityOn: boolean,
	fileKind: (fileId: string | null) => string,
): AttentionItem[] {
	const items: AttentionItem[] = [];
	const coveredFindings = new Set<string>();
	const seenConsistency = new Set<string>();
	if (integrityOn) {
		for (const doc of integrityDocs.values()) {
			for (const item of doc.consistency) {
				if (item.findingState === "match") continue;
				coveredFindings.add(`${doc.documentFileId}:${item.field}`);
				coveredFindings.add(`${item.left.documentFileId}:${item.field}`);
				coveredFindings.add(`${item.right.documentFileId}:${item.field}`);
				if (seenConsistency.has(item.id)) continue;
				seenConsistency.add(item.id);
				const isMismatch = item.findingState === "mismatch";
				items.push({
					key: `${doc.documentFileId}:consistency:${item.id}`,
					docId: doc.documentFileId,
					severity: item.severity,
					priority: isMismatch ? 0 : 1,
					action: isMismatch ? "review" : "open",
					title: `${fieldLabel(item.field)} ${isMismatch ? "mismatch" : "needs chase"}`,
					detail: clean(item.explanation ?? item.reason),
				});
			}
			for (const signal of doc.signals) {
				if (!isActionableSignal(signal.code)) continue;
				items.push({
					key: `${doc.documentFileId}:signal:${signal.code}`,
					docId: doc.documentFileId,
					severity: signal.severity,
					priority: 1,
					action: "open",
					title: clean(signal.summary),
					detail: clean(signal.code),
				});
			}
			if (doc.duplicateCount > 0) {
				items.push({
					key: `${doc.documentFileId}:duplicate`,
					docId: doc.documentFileId,
					severity: "medium",
					priority: 1,
					action: "open",
					title: "Same-case duplicate document",
					detail: `${doc.duplicateCount} duplicate${doc.duplicateCount === 1 ? "" : "s"} in this case`,
				});
			}
			if (doc.crossApplicationRestricted) {
				items.push({
					key: `${doc.documentFileId}:cross-application`,
					docId: doc.documentFileId,
					severity: "high",
					priority: 1,
					action: "open",
					title: "Cross-application match restricted",
					detail: "Shown only to the assigned officer",
				});
			}
		}
	}
	for (const finding of crosscheckFindings) {
		if (
			finding.documentFileId !== null &&
			coveredFindings.has(`${finding.documentFileId}:${finding.field}`)
		) {
			continue;
		}
		const severity: IntegritySeverity =
			finding.confidence === "high" || finding.confidence === "medium" ? finding.confidence : "low";
		const isMismatch = finding.status === "mismatch";
		const docKind =
			finding.documentFileId === null
				? "Manual review"
				: clean(fieldLabel(fileKind(finding.documentFileId)));
		const reason = clean(finding.reason).replaceAll("_", " ");
		const isOther = finding.field === "other";
		items.push({
			key: `${finding.documentFileId ?? "manual"}:crosscheck:${finding.id}`,
			docId: finding.documentFileId,
			severity,
			priority: isMismatch ? 0 : 1,
			action: "review",
			title: isOther
				? `${isMismatch ? "Mismatch" : "Needs chase"}: ${docKind}`
				: `${fieldLabel(finding.field)} ${finding.status}`,
			detail: isOther ? reason : `${reason} · ${docKind}`,
		});
	}
	const seen = new Set<string>();
	return items
		.filter((item) => {
			const key = `${item.docId ?? "manual"}:${item.title}:${item.detail}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.priority - b.priority,
		);
}

function FileFingerprint({ file }: { file: DocumentFile }) {
	return (
		<div>
			<h4 className="text-xs font-semibold text-slate">File details</h4>
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">SHA-256: </dt>
					<dd className="inline font-mono" title={file.sha256}>
						{file.sha256.slice(0, 12)}…
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Size: </dt>
					<dd className="inline tabular-nums">{(file.sizeBytes / 1024).toFixed(1)} KB</dd>
				</div>
				<div>
					<dt className="inline font-medium">Type: </dt>
					<dd className="inline font-mono">{clean(file.mimeType)}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Pages: </dt>
					<dd className="inline tabular-nums">{file.pageCount}</dd>
				</div>
				<div>
					<dt className="inline font-medium">OCR confidence: </dt>
					<dd className="inline tabular-nums">
						{file.ocrConfidence === null ? "—" : Number(file.ocrConfidence).toFixed(2)}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Keep until: </dt>
					<dd className="inline">{formatDate(file.retentionUntil)}</dd>
				</div>
				{file.errorCode && (
					<div>
						<dt className="inline font-medium">Reason: </dt>
						<dd className="inline">{clean(file.errorCode)}</dd>
					</div>
				)}
			</dl>
		</div>
	);
}

function splitFindings(
	integrityDoc: IntegrityDocumentPanel | undefined,
	crosscheckFindings: CrosscheckFinding[],
): { consistency: IntegrityDocumentPanel["consistency"]; crosscheck: CrosscheckFinding[] } {
	const consistency = (integrityDoc?.consistency ?? []).filter(
		(item) => item.findingState !== "match",
	);
	const coveredFields = new Set(consistency.map((item) => item.field));
	return {
		consistency,
		crosscheck: crosscheckFindings.filter((finding) => !coveredFields.has(finding.field)),
	};
}

function FindingsPane({
	applicationId,
	integrityDoc,
	crosscheckFindings,
	crosscheckPending,
	selectedFindings,
	onToggleFinding,
	fileKind,
	onChanged,
}: {
	applicationId: string;
	integrityDoc: IntegrityDocumentPanel | undefined;
	crosscheckFindings: CrosscheckFinding[];
	crosscheckPending: boolean;
	selectedFindings: Set<string>;
	onToggleFinding: (id: string) => void;
	fileKind: (fileId: string | null) => string;
	onChanged: () => void;
}) {
	const split = splitFindings(integrityDoc, crosscheckFindings);
	const signals = (integrityDoc?.signals ?? []).filter((signal) => isActionableSignal(signal.code));
	if (split.consistency.length === 0 && split.crosscheck.length === 0 && signals.length === 0) {
		return (
			<p className="text-sm text-slate">
				{crosscheckPending ? "Checking cross-check…" : "No findings for this document."}
			</p>
		);
	}
	return (
		<div className="space-y-4">
			{signals.length > 0 && (
				<div>
					<h4 className="mb-1 text-xs font-medium text-slate">Signals</h4>
					<SignalChips signals={signals} />
				</div>
			)}
			{split.consistency.length > 0 && (
				<ul className="space-y-2">
					{split.consistency.map((item) => (
						<ConsistencyItem
							key={item.id}
							applicationId={applicationId}
							item={item}
							onChanged={onChanged}
						/>
					))}
				</ul>
			)}
			{split.crosscheck.length > 0 && (
				<div>
					{split.consistency.length > 0 && (
						<h4 className="mb-1 text-xs font-medium text-slate">Cross-check findings</h4>
					)}
					<ul className="space-y-2">
						{split.crosscheck.map((finding) => (
							<FindingItem
								key={finding.id}
								finding={finding}
								fileKind={fileKind}
								selectable
								selected={selectedFindings.has(finding.id)}
								onToggle={() => onToggleFinding(finding.id)}
							/>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function EvidenceDetailTabs({
	applicationId,
	file,
	integrityDoc,
	crosscheckFindings,
	crosscheckPending,
	focusSignal,
	selectedFindings,
	onToggleFinding,
	fileKind,
	onChanged,
	onInspected,
}: {
	applicationId: string;
	file: DocumentFile;
	integrityDoc: IntegrityDocumentPanel | undefined;
	crosscheckFindings: CrosscheckFinding[];
	crosscheckPending: boolean;
	focusSignal: number;
	selectedFindings: Set<string>;
	onToggleFinding: (id: string) => void;
	fileKind: (fileId: string | null) => string;
	onChanged: () => void;
	onInspected: (fileId: string) => void;
}) {
	const [tabState, setTabState] = useState<{ signal: number; tab: DetailTab }>({
		signal: focusSignal,
		tab: "findings",
	});
	const tab = tabState.signal === focusSignal ? tabState.tab : "findings";
	const setTab = (next: DetailTab) => setTabState({ signal: focusSignal, tab: next });
	const split = splitFindings(integrityDoc, crosscheckFindings);
	const signalCount = (integrityDoc?.signals ?? []).filter((signal) =>
		isActionableSignal(signal.code),
	).length;
	return (
		<div>
			<Tabs
				ariaLabel={`${fieldLabel(file.kind)} details`}
				items={[
					{
						value: "findings",
						label: "Findings",
						count: split.consistency.length + split.crosscheck.length + signalCount,
					},
					{ value: "fields", label: "Extracted fields", count: integrityDoc?.candidates.length },
					{ value: "details", label: "Details" },
				]}
				value={tab}
				onChange={setTab}
			/>
			<div className="mt-4">
				{tab === "findings" && (
					<FindingsPane
						applicationId={applicationId}
						integrityDoc={integrityDoc}
						crosscheckFindings={crosscheckFindings}
						crosscheckPending={crosscheckPending}
						selectedFindings={selectedFindings}
						onToggleFinding={onToggleFinding}
						fileKind={fileKind}
						onChanged={onChanged}
					/>
				)}
				{tab === "fields" &&
					(integrityDoc === undefined ? (
						<p className="text-sm text-slate">No extracted fields for this document.</p>
					) : integrityDoc.candidates.length === 0 ? (
						<p className="text-sm text-slate">No extracted fields for this document.</p>
					) : (
						<ul className="divide-y divide-rule">
							{integrityDoc.candidates.map((candidate) => (
								<CandidateRow
									key={candidate.id}
									applicationId={applicationId}
									candidate={candidate}
									onChanged={onChanged}
								/>
							))}
						</ul>
					))}
				{tab === "details" && (
					<div className="space-y-4">
						<DocumentActions
							applicationId={applicationId}
							file={file}
							onChanged={onChanged}
							onInspected={onInspected}
							showPages
						/>
						{file.errorCode && (
							<p className="text-xs text-danger-ink">Reason: {clean(file.errorCode)}</p>
						)}
						{integrityDoc !== undefined &&
							(integrityDoc.duplicateCount > 0 || integrityDoc.crossApplicationRestricted) && (
								<div className="flex flex-wrap gap-2 text-xs text-slate">
									{integrityDoc.duplicateCount > 0 && (
										<span className="rounded bg-tag-amber px-1.5 py-0.5 text-warning-ink">
											{integrityDoc.duplicateCount} same-case duplicate
											{integrityDoc.duplicateCount === 1 ? "" : "s"}
										</span>
									)}
									{integrityDoc.crossApplicationRestricted && (
										<span
											className="rounded bg-warm px-1.5 py-0.5 text-slate"
											title="A cross-application match exists but is shown only to the assigned officer"
										>
											restricted cross-application match
										</span>
									)}
								</div>
							)}
						{integrityDoc === undefined ? (
							<FileFingerprint file={file} />
						) : (
							<FingerprintDetails doc={integrityDoc} />
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function EvidenceRow({
	applicationId,
	file,
	integrityDoc,
	crosscheckFindings,
	inspected,
	open,
	statusReady,
	crosscheckPending,
	focusSignal,
	selectedFindings,
	onToggleFinding,
	onToggle,
	onInspected,
	onChanged,
	fileKind,
}: {
	applicationId: string;
	file: DocumentFile;
	integrityDoc: IntegrityDocumentPanel | undefined;
	crosscheckFindings: CrosscheckFinding[];
	inspected: Set<string>;
	open: boolean;
	statusReady: boolean;
	crosscheckPending: boolean;
	focusSignal: number;
	selectedFindings: Set<string>;
	onToggleFinding: (id: string) => void;
	onToggle: () => void;
	onInspected: (fileId: string) => void;
	onChanged: () => void;
	fileKind: (fileId: string | null) => string;
}) {
	const issues = issueCount(integrityDoc, crosscheckFindings);
	const detailId = `evidence-detail-${file.id}`;
	return (
		<li className="border-t border-rule first:border-0">
			<div className="flex flex-wrap items-center gap-2 py-2.5">
				<button
					type="button"
					id={`evidence-toggle-${file.id}`}
					onClick={onToggle}
					aria-expanded={open}
					aria-controls={detailId}
					className="flex min-w-0 flex-1 items-center gap-3 text-left"
				>
					<ChevronRight
						className={cn("size-4 shrink-0 text-slate transition-transform", open && "rotate-90")}
						aria-hidden="true"
					/>
					<DocIcon kind={file.kind} />
					<span className="min-w-0">
						<span className="block text-sm font-medium text-ink">{fieldLabel(file.kind)}</span>
						<span
							className="block truncate text-xs text-slate"
							title={clean(file.originalFilename ?? "")}
						>
							{clean(file.originalFilename ?? "uploaded file")} · {file.pageCount} page
							{file.pageCount === 1 ? "" : "s"} · {(file.sizeBytes / 1024).toFixed(1)} KB ·{" "}
							{formatDate(file.uploadedAt)}
						</span>
					</span>
				</button>
				<StatusBadge status={file.status} />
				<span className="text-xs text-slate" aria-live="polite">
					OCR: {clean(ocrLabel(file))}
				</span>
				{file.textLayerRisk && <Tag tone="warning">hidden-text risk</Tag>}
				{inspected.has(file.id) && (
					<span className="rounded-sm bg-tag-green px-1.5 py-0.5 text-xs text-success-ink">
						original opened
					</span>
				)}
				<span
					className={cn(
						"w-16 text-right text-xs",
						issues > 0 ? "font-medium text-warning-ink" : "text-slate",
					)}
				>
					{!statusReady
						? "—"
						: issues > 0
							? `${issues} issue${issues === 1 ? "" : "s"}`
							: "No issues"}
				</span>
				<DocumentActions
					applicationId={applicationId}
					file={file}
					onChanged={onChanged}
					onInspected={onInspected}
					mode="row"
				/>
			</div>
			{open && (
				<div id={detailId} className="border-t border-rule bg-raised px-4 py-4">
					<EvidenceDetailTabs
						applicationId={applicationId}
						file={file}
						integrityDoc={integrityDoc}
						crosscheckFindings={crosscheckFindings}
						crosscheckPending={crosscheckPending}
						focusSignal={focusSignal}
						selectedFindings={selectedFindings}
						onToggleFinding={onToggleFinding}
						fileKind={fileKind}
						onChanged={onChanged}
						onInspected={onInspected}
					/>
				</div>
			)}
		</li>
	);
}

function EvidencePanelInner({ applicationId }: { applicationId: string }) {
	const queryClient = useQueryClient();
	const [claimConflict, setClaimConflict] = useState(false);
	const [claiming, setClaiming] = useState(false);
	const [claimError, setClaimError] = useState("");
	const [uploadOpen, setUploadOpen] = useState(false);
	const [openDocId, setOpenDocId] = useState<string | null>(null);
	const [openNonce, setOpenNonce] = useState(0);
	const [inspected, setInspected] = useState<Set<string>>(new Set());
	const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
	const [findingsOpen, setFindingsOpen] = useState<boolean | null>(null);
	const [crossBusy, setCrossBusy] = useState(false);
	const [crossError, setCrossError] = useState("");
	const [chaseBusy, setChaseBusy] = useState(false);
	const [chaseError, setChaseError] = useState("");
	const [draft, setDraft] = useState<ChaseDraft | null>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const [analyseBusy, setAnalyseBusy] = useState(false);
	const [analyseError, setAnalyseError] = useState("");

	const files = useQuery({
		queryKey: ["documents", applicationId],
		queryFn: () => fetchDocumentFiles(applicationId),
		retry: false,
	});
	const crosscheck = useQuery({
		queryKey: ["document-crosscheck", applicationId],
		queryFn: () => fetchCrosscheck(applicationId),
		retry: false,
		// Cross-check reads need an assignment first; skip until the file
		// list settles so an unassigned officer makes no extra call.
		enabled: files.isSuccess || files.isError,
	});
	const integrityQuery = useIntegrity(applicationId);
	const liveRun = useQuery({
		queryKey: ["integrity-run", applicationId, runId],
		queryFn: () => fetchIntegrityRun(applicationId, runId ?? ""),
		enabled: runId !== null,
		retry: false,
		refetchInterval: (query) => {
			const status = query.state.data?.run.status;
			return status === "queued" || status === "running" ? 3000 : false;
		},
	});

	const invalidateIntegrity = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["integrity", applicationId] });
	};
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		void queryClient.invalidateQueries({ queryKey: ["document-crosscheck", applicationId] });
		invalidateIntegrity();
	};

	// A finished background run changes candidates/consistency — reload once.
	useEffect(() => {
		const status = liveRun.data?.run.status;
		if (runId !== null && status !== undefined && status !== "queued" && status !== "running") {
			invalidateIntegrity();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveRun.data, runId]);

	async function claim() {
		setClaiming(true);
		setClaimError("");
		try {
			await claimDocuments(applicationId);
			refresh();
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) setClaimConflict(true);
			else setClaimError(friendlyMessage(err));
		} finally {
			setClaiming(false);
		}
	}

	async function analyse() {
		setAnalyseBusy(true);
		setAnalyseError("");
		try {
			const res = await requestIntegrityAnalysis(applicationId);
			setRunId(res.run.id);
			invalidateIntegrity();
		} catch (err) {
			setAnalyseError(friendlyMessage(err));
		} finally {
			setAnalyseBusy(false);
		}
	}

	async function runCrosscheckAction() {
		setCrossBusy(true);
		setCrossError("");
		try {
			await runCrosscheck(applicationId);
			refresh();
		} catch (err) {
			setCrossError(friendlyMessage(err));
		} finally {
			setCrossBusy(false);
		}
	}

	const unassigned = files.isError && files.error instanceof ApiError && files.error.status === 404;
	const consentBlocked =
		(files.isError && files.error instanceof ApiError && files.error.status === 403) ||
		(crosscheck.isError && crosscheck.error instanceof ApiError && crosscheck.error.status === 403);

	if (claimConflict) {
		return (
			<Panel title="Documents" outline>
				<p className="text-sm text-slate">Documents are not available for this case.</p>
			</Panel>
		);
	}

	if (unassigned) {
		return (
			<Panel title="Documents" outline>
				<p className="mb-3 text-sm text-slate">
					This case is not assigned yet. Claim it to work with its documents.
				</p>
				{claimError && (
					<div className="mb-3">
						<ErrorBox message={claimError} />
					</div>
				)}
				<Button type="button" variant="outline" onClick={() => void claim()} disabled={claiming}>
					{claiming ? "Claiming…" : "Assign to me"}
				</Button>
			</Panel>
		);
	}

	const filesData = files.data?.files ?? [];
	const integrity = integrityQuery.data ?? null;
	const integrityDocs = new Map(
		(integrity?.documents ?? []).map((doc) => [doc.documentFileId, doc]),
	);
	const crosscheckFindings = crosscheck.data?.findings ?? [];
	const hasManualFindings = crosscheckFindings.some((finding) => finding.documentFileId === null);
	const fileKind = (fileId: string | null): string =>
		filesData.find((file) => file.id === fileId)?.kind ?? "document";
	const attention = buildAttention(integrityDocs, crosscheckFindings, integrity !== null, fileKind);
	const statusReady = !files.isPending && !crosscheck.isPending && !integrityQuery.isPending;
	const live = liveRun.data?.run;
	const liveActive = live !== undefined && (live.status === "queued" || live.status === "running");

	const toggleSelected = (id: string): void => {
		setSelectedFindings((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const chosen = crosscheckFindings.filter((finding) => selectedFindings.has(finding.id));
	const citedIds = [
		...new Set(
			chosen.flatMap((finding) => (finding.documentFileId ? [finding.documentFileId] : [])),
		),
	];
	const unopened = citedIds.filter((id) => !inspected.has(id));
	const chaseReady = chosen.length > 0 && citedIds.length > 0 && unopened.length === 0;
	const showCrosscheckFindings = findingsOpen ?? hasManualFindings;
	const showChase = crosscheckFindings.length > 0 && (showCrosscheckFindings || chosen.length > 0);

	async function createDraft() {
		if (crosscheck.data === null || crosscheck.data === undefined) return;
		setChaseBusy(true);
		setChaseError("");
		try {
			const result = await createChaseDraft(
				applicationId,
				(crosscheck.data.crosscheck as { id: string }).id,
				[...selectedFindings],
			);
			setDraft(result);
		} catch (err) {
			setChaseError(friendlyMessage(err));
		} finally {
			setChaseBusy(false);
		}
	}

	function focusDoc(docId: string) {
		setOpenDocId(docId);
		setOpenNonce((value) => value + 1);
		window.requestAnimationFrame(() => {
			document.getElementById(`evidence-toggle-${docId}`)?.focus();
		});
	}

	const title = integrity !== null ? "Evidence & integrity" : "Documents";

	return (
		<Panel
			title={title}
			action={
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setUploadOpen((value) => !value)}
						aria-expanded={uploadOpen}
					>
						{uploadOpen ? "Hide upload" : "Upload"}
					</Button>
					{integrity !== null && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void analyse()}
							disabled={analyseBusy || liveActive}
						>
							{analyseBusy ? "Requesting…" : liveActive ? "Analysis running…" : "Analyse documents"}
						</Button>
					)}
				</div>
			}
			outline
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate">
				<span>
					{filesData.length} document{filesData.length === 1 ? "" : "s"}
				</span>
				{!statusReady ? (
					<>
						<span aria-hidden="true">·</span>
						<span>checking evidence…</span>
					</>
				) : attention.length > 0 ? (
					<>
						<span aria-hidden="true">·</span>
						<span>
							{attention.length} finding{attention.length === 1 ? "" : "s"} to review
						</span>
					</>
				) : null}
			</div>

			{integrityQuery.isPending && <p className="mt-1 text-xs text-slate">Integrity: checking…</p>}
			{integrityQuery.isError && (
				<p className="mt-1 text-xs text-danger-ink">
					Integrity: unavailable — the documents below still work.{" "}
					<button
						type="button"
						onClick={() => void integrityQuery.refetch()}
						className="font-medium underline"
					>
						Retry
					</button>
				</p>
			)}
			{integrity !== null && (
				<p className="mt-1 text-xs text-slate">
					A signal, not proof — open the original before relying on it.
				</p>
			)}
			{integrity !== null && integrity.latestAnalysis === null && (
				<p className="mt-1 text-xs text-slate">Integrity brief: not run.</p>
			)}
			{integrity !== null &&
				(integrity.latestAnalysis?.status === "queued" ||
					integrity.latestAnalysis?.status === "running") && (
					<p className="mt-1 text-xs text-slate" aria-live="polite">
						Integrity brief: running…
					</p>
				)}
			{integrity !== null && integrity.latestAnalysis?.status === "failed" && (
				<p className="mt-1 text-xs text-danger-ink">
					Integrity brief: failed — retry Analyse documents.
				</p>
			)}

			{consentBlocked && (
				<p className="mt-3 text-sm text-slate" aria-live="polite">
					Document processing consent is required before documents can be used — the applicant has
					not granted it.
				</p>
			)}

			{uploadOpen && (
				<div className="mt-4">
					<UploadForm
						applicationId={applicationId}
						disabled={false}
						disabledHint={null}
						onUploaded={refresh}
					/>
				</div>
			)}

			{integrity !== null && <OpenReviewBanner integrity={integrity} />}

			{integrity !== null && integrity.caseSignals.length > 0 && (
				<div className="mt-3">
					<p className="text-xs font-medium text-slate">Case signals</p>
					<div className="mt-1">
						<SignalChips signals={integrity.caseSignals} />
					</div>
				</div>
			)}

			{files.isPending ? (
				<p className="mt-4 text-sm text-slate">Loading documents…</p>
			) : files.isError ? (
				<div className="mt-4">
					<ErrorBox message={friendlyMessage(files.error)} onRetry={() => void files.refetch()} />
				</div>
			) : filesData.length === 0 ? (
				<p className="mt-4 text-sm text-slate">No documents uploaded yet.</p>
			) : (
				<>
					{attention.length > 0 && (
						<div className="mt-5 border-t border-rule pt-4">
							<div className="flex items-end justify-between gap-3">
								<h3 className="text-sm font-medium text-ink">Needs attention</h3>
								<span className="text-xs text-slate">{attention.length} items</span>
							</div>
							<ul className="mt-1 divide-y divide-rule">
								{attention.map((item) => (
									<li key={item.key}>
										<button
											type="button"
											onClick={() =>
												item.docId === null ? focusCrosscheck() : focusDoc(item.docId)
											}
											className="flex w-full items-start gap-3 py-2.5 text-left transition-colors hover:bg-raised"
										>
											<StatusBadge status={item.severity} />
											<span className="min-w-0 flex-1">
												<span className="block text-sm font-medium text-ink">{item.title}</span>
												<span className="mt-0.5 block text-xs text-slate">{item.detail}</span>
											</span>
											<span className="shrink-0 text-xs font-medium text-red-link">
												{item.docId === null
													? "Cross-check ↓"
													: item.action === "review"
														? "Review →"
														: "Open →"}
											</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					)}

					<div className="mt-5 border-t border-rule pt-4">
						<div className="flex items-end justify-between gap-3">
							<h3 className="text-sm font-medium text-ink">Documents</h3>
							<span className="text-xs text-slate">
								{filesData.length} file{filesData.length === 1 ? "" : "s"}
							</span>
						</div>
						<ul className="mt-1">
							{filesData.map((file) => {
								const open = openDocId === file.id;
								return (
									<EvidenceRow
										key={file.id}
										applicationId={applicationId}
										file={file}
										integrityDoc={integrityDocs.get(file.id)}
										crosscheckFindings={crosscheckFindings.filter(
											(finding) => finding.documentFileId === file.id,
										)}
										inspected={inspected}
										open={open}
										statusReady={statusReady}
										crosscheckPending={crosscheck.isPending}
										focusSignal={openNonce}
										selectedFindings={selectedFindings}
										onToggleFinding={toggleSelected}
										onToggle={() => setOpenDocId(open ? null : file.id)}
										onInspected={(id) => setInspected((prev) => new Set(prev).add(id))}
										onChanged={refresh}
										fileKind={fileKind}
									/>
								);
							})}
						</ul>
					</div>
				</>
			)}

			<div id="evidence-crosscheck" tabIndex={-1} className="mt-5 border-t border-rule pt-4">
				<h3 className="text-sm font-medium text-ink">Cross-check</h3>
				{crosscheck.isPending ? (
					<p className="mt-1 text-sm text-slate">Loading cross-check…</p>
				) : crosscheck.isError ? (
					<div className="mt-1">
						<ErrorBox
							message={friendlyMessage(crosscheck.error)}
							onRetry={() => void crosscheck.refetch()}
						/>
					</div>
				) : crosscheck.data === null || crosscheck.data === undefined ? (
					<p className="mt-1 text-sm text-slate">No cross-check run yet.</p>
				) : (
					<div className="mt-1 text-xs text-slate">
						<p>
							Run {shortId((crosscheck.data.crosscheck as { id: string }).id)} ·{" "}
							{(crosscheck.data.crosscheck as { status: string }).status} ·{" "}
							{(crosscheck.data.crosscheck as { findingCount: number }).findingCount} finding
							{(crosscheck.data.crosscheck as { findingCount: number }).findingCount === 1
								? ""
								: "s"}
						</p>
						{crosscheckFindings.length > 0 && (
							<details
								open={showCrosscheckFindings}
								onToggle={(event) => setFindingsOpen(event.currentTarget.open)}
								className="mt-2"
							>
								<summary className="cursor-pointer text-xs font-medium text-ink">
									Cross-check findings ({crosscheckFindings.length})
								</summary>
								<ul className="mt-2 space-y-2">
									{crosscheckFindings.map((finding) => (
										<FindingItem
											key={finding.id}
											finding={finding}
											fileKind={fileKind}
											selected={selectedFindings.has(finding.id)}
											onToggle={() => toggleSelected(finding.id)}
										/>
									))}
								</ul>
							</details>
						)}
					</div>
				)}
				{crossError && (
					<div className="mt-2">
						<ErrorBox message={crossError} />
					</div>
				)}
				<div className="mt-2 flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => void runCrosscheckAction()}
						disabled={crossBusy}
					>
						{crossBusy ? "Checking…" : "Run cross-check"}
					</Button>
				</div>

				{showChase && (
					<div className="mt-3">
						<h4 className="text-sm font-medium text-ink">Draft chase</h4>
						<p className="mt-0.5 text-xs text-slate">
							Select findings above or in a document row, open the cited original
							{citedIds.length > 1 ? "s" : ""}, then draft. Drafts are never sent from here.
						</p>
						{chosen.length > 0 && unopened.length > 0 && (
							<p className="mt-1 text-sm text-warning-ink" aria-live="polite">
								Open the original{unopened.length > 1 ? "s" : ""} for the selected cited file
								{unopened.length > 1 ? "s" : ""} before drafting.
							</p>
						)}
						{chosen.length > 0 && citedIds.length === 0 && (
							<p className="mt-1 text-sm text-warning-ink" aria-live="polite">
								The selected findings cite no openable document — a draft needs at least one cited
								file.
							</p>
						)}
						{chaseError && (
							<div className="mt-2">
								<ErrorBox message={chaseError} />
							</div>
						)}
						<div className="mt-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => void createDraft()}
								disabled={!chaseReady || chaseBusy}
								aria-label="Create draft chase request"
							>
								{chaseBusy ? "Drafting…" : "Create draft chase"}
							</Button>
						</div>
						{draft && (
							<div
								className="mt-2 rounded-sm border border-rule bg-tag-green p-3"
								aria-live="polite"
							>
								<p className="text-sm font-medium text-success-ink">Draft created — not sent</p>
								<p className="mt-1 whitespace-pre-wrap break-words text-sm text-success-ink">
									{clean((draft.chase as { body: string | null }).body ?? "")}
								</p>
							</div>
						)}
					</div>
				)}
			</div>

			{integrity !== null && (
				<>
					{live !== undefined && (
						<p className="mt-4 flex flex-wrap items-center gap-1.5 text-sm text-slate">
							Run {shortId(live.id)} <StatusBadge status={live.status} />
							{live.errorCode && (
								<span className="font-mono text-xs">({clean(live.errorCode)})</span>
							)}
						</p>
					)}
					{analyseError && (
						<div className="mt-3">
							<ErrorBox message={analyseError} />
						</div>
					)}
					{integrity.latestAnalysis !== null && (
						<details className="mt-4 border-t border-rule pt-3">
							<summary className="cursor-pointer text-xs font-medium text-slate">
								Integrity analysis run
							</summary>
							<div className="mt-2">
								<TraceDetails
									trace={{
										runId: integrity.latestAnalysis.id,
										runStatus: integrity.latestAnalysis.status,
										model: integrity.latestAnalysis.model,
										promptVersion: integrity.latestAnalysis.promptVersion,
										agentVersion: integrity.latestAnalysis.agentVersion,
										steps: integrity.latestAnalysis.steps,
										toolCalls: integrity.latestAnalysis.toolCalls,
										sourceRefs: integrity.latestAnalysis.sourceRefs,
										repairAttempted: integrity.latestAnalysis.repairAttempted,
										repairSucceeded: integrity.latestAnalysis.repairSucceeded,
										inputTokens: integrity.latestAnalysis.usage?.inputTokens,
										outputTokens: integrity.latestAnalysis.usage?.outputTokens,
										costUsd: integrity.latestAnalysis.usage?.costUsd,
										errorCode: integrity.latestAnalysis.errorCode,
									}}
								/>
							</div>
						</details>
					)}
					<details className="mt-4 border-t border-rule pt-3">
						<summary className="cursor-pointer text-sm font-medium text-ink">
							Flag for fraud review
						</summary>
						<FlagControls
							applicationId={applicationId}
							onChanged={invalidateIntegrity}
							hideHeading
						/>
					</details>
				</>
			)}
		</Panel>
	);
}

/** Officer evidence panel. Hides when the documents flag is off; the
 * integrity half hides itself when its own read is a 404. */
export function EvidencePanel({
	applicationId,
	documentsEnabled,
}: {
	applicationId: string;
	documentsEnabled: boolean;
}) {
	if (!documentsEnabled) return null;
	return <EvidencePanelInner applicationId={applicationId} />;
}
