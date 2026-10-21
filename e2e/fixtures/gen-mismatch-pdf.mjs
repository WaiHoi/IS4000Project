// One-off generator for e2e/fixtures/mismatch.pdf: a minimal single-page
// PDF with a real text layer (Company Name + Registration No labels the
// deterministic cross-check reads). Run with `node gen-mismatch-pdf.mjs`
// from this directory, then delete this file is optional — it stays as the
// fixture's provenance.
import { writeFileSync } from "node:fs";

const lines = ["Company Name: Harbour Foods Ltd", "Registration No: 201899999K"];
const content = lines.map((t, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${t}) Tj ET`).join("\n");

const objects = [
	"<< /Type /Catalog /Pages 2 0 R >>",
	"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
	"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
	`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "%PDF-1.4\n";
const offsets = [];
for (let i = 0; i < objects.length; i++) {
	offsets.push(pdf.length);
	pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;

writeFileSync("mismatch.pdf", pdf);
console.log(`wrote mismatch.pdf (${pdf.length} bytes)`);
