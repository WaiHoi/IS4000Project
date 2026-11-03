// Policy bodies are imported hard-wrapped (one sentence fragment per source
// line). The provider should wrap to its own measure, not preserve those
// source newlines. Blank lines still separate paragraphs.

function collapseLineWhitespace(text: string): string {
	return text
		.replace(/\s*\n\s*/g, " ")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export function policyParagraphs(body: string): string[] {
	return body
		.replace(/\r\n/g, "\n")
		.split(/\n{2,}/)
		.map(collapseLineWhitespace)
		.filter((paragraph) => paragraph.length > 0);
}

export function policyQuote(quote: string): string {
	return collapseLineWhitespace(quote.replace(/\r\n/g, "\n"));
}
