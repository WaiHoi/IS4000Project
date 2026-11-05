// T01/T02 document panel (SPEC-t01-t02 §9, D3 UI only): applicant consent +
// upload/list/download/retry. The officer evidence workflow composes the
// shared file actions and finding row from this module in `evidence-panel`.
// Deterministic only — no send path, no model call, no decision effect. All
// document text renders as React text nodes (never dangerouslySetInnerHTML);
// bidi/zero-width controls are stripped in display; nothing document-derived
// reaches console, logs, or URLs.
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	ApiError,
	downloadDocument,
	fetchDocumentFiles,
	fetchDocumentPages,
	fieldLabel,
	formatDate,
	queryKeys,
	retryDocumentOcr,
	toast,
	updateDocumentConsent,
	uploadDocument,
	type DocumentCrosscheck,
	type DocumentFile,
	type DocumentKind,
	type DocumentsList,
} from "../lib/api";
import { clean, friendlyMessage, shortId } from "../lib/format";
import { ErrorBox, Panel, StatusBadge, inputCls } from "./ubs";

const KINDS: DocumentKind[] = [
	"business_registration",
	"bank_statement",
	"payslip",
	"financial_statements",
	"id",
	"other",
];

export function ocrLabel(file: DocumentFile): string {
	if (file.kind === "id") return "no text (ID)";
	return file.ocrStatus.replaceAll("_", " ");
}

export function DocumentActions({
	applicationId,
	file,
	onChanged,
	onInspected,
	showPages = false,
	mode = "full",
}: {
	applicationId: string;
	file: DocumentFile;
	onChanged: () => void;
	onInspected?: (fileId: string) => void;
	showPages?: boolean;
	mode?: "full" | "open-only" | "row";
}) {
	const [pagesOpen, setPagesOpen] = useState(false);
	const [busy, setBusy] = useState<"download" | "open" | "retry" | null>(null);
	const [error, setError] = useState("");
	const pages = useQuery({
		queryKey: ["document-pages", applicationId, file.id],
		queryFn: () => fetchDocumentPages(applicationId, file.id),
		retry: false,
		enabled: showPages && pagesOpen,
	});
	const retryable =
		file.status === "ready" &&
		file.kind !== "id" &&
		(file.ocrStatus === "failed" || file.ocrStatus === "unsupported");

	async function save(openInTab: boolean) {
		setBusy(openInTab ? "open" : "download");
		setError("");
		let url = "";
		try {
			const { blob, filename } = await downloadDocument(applicationId, file.id);
			url = URL.createObjectURL(blob);
			if (openInTab) {
				window.open(url, "_blank", "noopener");
				// Keep the blob URL alive for the new tab, then release it.
				window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
			} else {
				const a = document.createElement("a");
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				URL.revokeObjectURL(url);
				url = "";
			}
			onInspected?.(file.id);
		} catch (err) {
			if (url !== "") URL.revokeObjectURL(url);
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	async function retry() {
		setBusy("retry");
		setError("");
		try {
			await retryDocumentOcr(applicationId, file.id);
			onChanged();
		} catch (err) {
			setError(friendlyMessage(err));
		} finally {
			setBusy(null);
		}
	}

	if (mode === "open-only") {
		return (
			<>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(true)}
					disabled={busy !== null}
					aria-label={`Open original document ${shortId(file.id)}`}
				>
					{busy === "open" ? "Opening…" : "Open original"}
				</Button>
				{error && <ErrorBox message={error} />}
			</>
		);
	}

	if (mode === "row") {
		return (
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(true)}
					disabled={busy !== null}
					aria-label={`Open original document ${shortId(file.id)}`}
				>
					{busy === "open" ? "Opening…" : "Open original"}
				</Button>
				{retryable && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void retry()}
						disabled={busy !== null}
						aria-label={`Retry text extraction for document ${shortId(file.id)}`}
					>
						{busy === "retry" ? "Retrying…" : "Retry OCR"}
					</Button>
				)}
				{error && <ErrorBox message={error} />}
			</div>
		);
	}

	return (
		<>
			{error && (
				<div className="mb-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(false)}
					disabled={busy !== null}
					aria-label={`Download document ${shortId(file.id)}`}
				>
					{busy === "download" ? "Preparing…" : "Download"}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void save(true)}
					disabled={busy !== null}
					aria-label={`Open original document ${shortId(file.id)}`}
				>
					{busy === "open" ? "Opening…" : "Open original"}
				</Button>
				{showPages && file.kind !== "id" && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setPagesOpen((v) => !v)}
						aria-expanded={pagesOpen}
						aria-label={`View page text for document ${shortId(file.id)}`}
					>
						{pagesOpen ? "Hide pages" : "View pages"}
					</Button>
				)}
				{retryable && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void retry()}
						disabled={busy !== null}
						aria-label={`Retry text extraction for document ${shortId(file.id)}`}
					>
						{busy === "retry" ? "Retrying…" : "Retry OCR"}
					</Button>
				)}
			</div>
			{showPages && pagesOpen && (
				<div className="mt-2" aria-live="polite">
					{pages.isPending ? (
						<p className="text-sm text-slate">Loading pages…</p>
					) : pages.isError ? (
						<ErrorBox message={friendlyMessage(pages.error)} onRetry={() => void pages.refetch()} />
					) : pages.data.pages.length === 0 ? (
						<p className="text-sm text-slate">No page text — this file needs a manual check.</p>
					) : (
						<ol className="space-y-2">
							{pages.data.pages.map((p) => (
								<li key={p.pageNumber} className="rounded-sm bg-raised p-2 text-sm">
									<p className="text-xs text-slate">
										Page {p.pageNumber} · {clean(p.source)} · confidence{" "}
										{Number(p.confidence).toFixed(2)}
									</p>
									<p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink">
										{clean(p.text)}
									</p>
								</li>
							))}
						</ol>
					)}
				</div>
			)}
		</>
	);
}

function FileRow({
	applicationId,
	file,
	onChanged,
	inspected,
	onInspected,
	showPages,
}: {
	applicationId: string;
	file: DocumentFile;
	onChanged: () => void;
	inspected?: Set<string>;
	onInspected?: (fileId: string) => void;
	showPages?: boolean;
}) {
	return (
		<li className="rounded-sm border border-rule p-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StatusBadge status={file.status} />
				<span className="font-medium text-ink">{fieldLabel(file.kind)}</span>
				<span className="text-xs text-slate" aria-live="polite">
					OCR: {clean(ocrLabel(file))}
					{file.textLayerRisk ? " · hidden-text risk" : ""}
				</span>
				{inspected?.has(file.id) && (
					<span className="rounded-sm bg-tag-green px-1.5 py-0.5 text-xs text-success-ink">
						original opened
					</span>
				)}
			</div>
			<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate">
				<div>
					<dt className="inline font-medium">Pages: </dt>
					<dd className="inline">{file.pageCount}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Size: </dt>
					<dd className="inline">{(file.sizeBytes / 1024).toFixed(1)} KB</dd>
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
			<div className="mt-2">
				<DocumentActions
					applicationId={applicationId}
					file={file}
					onChanged={onChanged}
					onInspected={onInspected}
					showPages={showPages}
				/>
			</div>
		</li>
	);
}

export function UploadForm({
	applicationId,
	disabled,
	disabledHint,
	onUploaded,
}: {
	applicationId: string;
	disabled: boolean;
	disabledHint: string | null;
	onUploaded: () => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [kind, setKind] = useState<DocumentKind>("business_registration");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function upload() {
		const picked = inputRef.current?.files?.[0];
		if (!picked) {
			setError("Choose a PDF, PNG, or JPEG first.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await uploadDocument(applicationId, picked, kind);
			if (inputRef.current) inputRef.current.value = "";
			onUploaded();
		} catch (err) {
			const message = friendlyMessage(err);
			setError(message);
			if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 422)) toast(message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-sm border border-rule p-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="document-kind">Document kind</Label>
					<select
						id="document-kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as DocumentKind)}
						disabled={disabled || busy}
						className={inputCls}
					>
						{KINDS.map((k) => (
							<option key={k} value={k}>
								{fieldLabel(k)}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="document-file">File (PDF, PNG, JPEG · ≤10 MB)</Label>
					<input
						ref={inputRef}
						id="document-file"
						type="file"
						accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
						disabled={disabled || busy}
						className="w-full text-sm text-ink disabled:opacity-50"
					/>
				</div>
			</div>
			{disabledHint && <p className="mt-2 text-sm text-slate">{disabledHint}</p>}
			{error && (
				<div className="mt-2">
					<ErrorBox message={error} />
				</div>
			)}
			<div className="mt-3">
				<Button
					type="button"
					variant="outline"
					onClick={() => void upload()}
					disabled={disabled || busy}
				>
					{busy ? "Uploading…" : "Upload document"}
				</Button>
			</div>
		</div>
	);
}

function DocumentFileList({
	applicationId,
	files,
	onChanged,
	inspected,
	onInspected,
	showPages,
}: {
	applicationId: string;
	files: UseQueryResult<DocumentsList>;
	onChanged: () => void;
	inspected?: Set<string>;
	onInspected?: (fileId: string) => void;
	showPages?: boolean;
}) {
	return (
		<div className="mt-3" aria-live="polite">
			{files.isPending ? (
				<p className="text-sm text-slate">Loading documents…</p>
			) : files.isError ? (
				<ErrorBox message={friendlyMessage(files.error)} onRetry={() => void files.refetch()} />
			) : files.data.files.length === 0 ? (
				<p className="text-sm text-slate">No documents uploaded yet.</p>
			) : (
				<ul className="space-y-2">
					{files.data.files.map((f) => (
						<FileRow
							key={f.id}
							applicationId={applicationId}
							file={f}
							onChanged={onChanged}
							inspected={inspected}
							onInspected={onInspected}
							showPages={showPages}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function ApplicantDocuments({
	applicationId,
	consent,
}: {
	applicationId: string;
	consent: boolean;
}) {
	const queryClient = useQueryClient();
	const [checked, setChecked] = useState(consent);
	const [saving, setSaving] = useState(false);
	const [consentError, setConsentError] = useState("");
	const files = useQuery({
		queryKey: ["documents", applicationId],
		queryFn: () => fetchDocumentFiles(applicationId),
		retry: false,
		enabled: consent,
	});
	const refresh = (): void => {
		void queryClient.invalidateQueries({ queryKey: ["documents", applicationId] });
		void queryClient.invalidateQueries({ queryKey: queryKeys.case(applicationId) });
		void queryClient.invalidateQueries({ queryKey: ["integrity", applicationId] });
	};

	async function saveConsent() {
		setSaving(true);
		setConsentError("");
		try {
			await updateDocumentConsent(applicationId, checked);
			refresh();
		} catch (err) {
			setConsentError(friendlyMessage(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Panel title="Documents" outline>
			<p className="mb-3 text-xs text-slate">
				Your files are scanned, encrypted, and kept for 90 days. Withdrawing consent blocks future
				uploads and schedules deletion.
			</p>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-sm text-ink">
					<input
						type="checkbox"
						checked={checked}
						onChange={(e) => setChecked(e.target.checked)}
						aria-label="Consent to document processing"
						className="size-5"
					/>
					I consent to document processing
				</label>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void saveConsent()}
					disabled={saving || checked === consent}
				>
					{saving ? "Saving…" : "Update consent"}
				</Button>
			</div>
			{consentError && (
				<div className="mb-3">
					<ErrorBox message={consentError} />
				</div>
			)}
			<UploadForm
				applicationId={applicationId}
				disabled={!consent}
				disabledHint={
					!consent
						? "Uploads need document-processing consent — tick the box and update first."
						: null
				}
				onUploaded={refresh}
			/>
			{consent ? (
				<DocumentFileList applicationId={applicationId} files={files} onChanged={refresh} />
			) : (
				<p className="text-sm text-slate">
					Consent to document processing to view uploaded documents.
				</p>
			)}
		</Panel>
	);
}

export function FindingItem({
	finding,
	fileKind,
	selected = false,
	onToggle,
	selectable = true,
}: {
	finding: DocumentCrosscheck["findings"][number];
	fileKind: (fileId: string | null) => string;
	selected?: boolean;
	onToggle?: () => void;
	selectable?: boolean;
}) {
	const summary = (
		<span>
			<span className="font-medium" title={clean(finding.field)}>
				{fieldLabel(finding.field)}
			</span>{" "}
			<StatusBadge status={finding.status} />
			<span className="ml-2 text-xs text-slate">{clean(finding.reason).replaceAll("_", " ")}</span>
		</span>
	);
	return (
		<li className="rounded-sm border border-rule p-3">
			{selectable ? (
				<label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
					<input
						type="checkbox"
						checked={selected}
						onChange={onToggle}
						aria-label={`Select finding ${finding.field} for chase draft`}
						className="mt-1 size-4"
					/>
					{summary}
				</label>
			) : (
				<div className="text-sm text-ink">{summary}</div>
			)}
			<dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate sm:grid-cols-2">
				<div>
					<dt className="inline font-medium">Expected: </dt>
					<dd className="inline break-words">{clean(finding.expected ?? "not available")}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Observed: </dt>
					<dd className="inline break-words">{clean(finding.observed ?? "not available")}</dd>
				</div>
				<div>
					<dt className="inline font-medium">Document: </dt>
					<dd className="inline">
						{finding.documentFileId
							? `${fieldLabel(fileKind(finding.documentFileId))} · ${shortId(finding.documentFileId)}`
							: "no usable document — manual review"}
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">Page: </dt>
					<dd className="inline">{finding.pageNumber ?? "—"}</dd>
				</div>
			</dl>
			{finding.quote !== null ? (
				<blockquote className="mt-2 border-l-2 border-rule-strong pl-2 text-sm text-ink italic">
					{clean(finding.quote)}
				</blockquote>
			) : (
				<p className="mt-1 text-xs text-slate">No citable quote — needs a manual check.</p>
			)}
		</li>
	);
}

/** Applicant document workflow. The officer evidence workflow lives in
 * `evidence-panel.tsx`; this panel is only mounted on applicant pages. */
export function DocumentPanel({
	applicationId,
	documentsEnabled,
	documentProcessingConsent,
}: {
	applicationId: string;
	documentsEnabled: boolean;
	documentProcessingConsent: boolean;
}) {
	if (!documentsEnabled) {
		return null;
	}
	return <ApplicantDocuments applicationId={applicationId} consent={documentProcessingConsent} />;
}
