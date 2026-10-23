// Deterministic text-PDF builder for demo evidence (SPEC-t17-t18 §2.5).
// Same minimal-PDF technique as `e2e/fixtures/gen-mismatch-pdf.mjs`: one
// page, Helvetica, one `Tj` per line. Bytes depend only on the input lines,
// so every seed produces the same sha256. The lines double as the stored
// page text (via `createCustomerDocument` pages), which keeps the T02
// cross-check deterministic: label lines (`Company Name:`, `Registration
// No:`, `Account Holder:`) are exactly what the extractor reads.
function escapePdfText(line: string): string {
	return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Minimal single-page text PDF for `lines` (header + one line per entry). */
export function demoPdfForLines(header: string, lines: string[]): Buffer {
	const content = [header, ...lines]
		.map((t, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${escapePdfText(t)}) Tj ET`)
		.join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xrefAt = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
	return Buffer.from(pdf, "utf8");
}

/** Evidence bytes + stored page text for one manifest evidence entry. */
export function demoEvidenceBytes(evidence: { title: string; lines: string[] }): {
	bytes: Buffer;
	text: string;
} {
	const text = [evidence.title, ...evidence.lines].join("\n");
	return { bytes: demoPdfForLines(evidence.title, evidence.lines), text };
}
