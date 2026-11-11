/**
 * Credential detection for everything written to `.ad/`. The diary is meant to be committed, so a key
 * pasted into an entry would end up in git history. Writes containing one are rejected; the message
 * names the kind of secret but never echoes it.
 *
 * Patterns are deliberately specific (well-known token formats) plus one generic `name = value` rule
 * that requires a value with both letters and digits, so prose like "token refresh" or
 * "password: required" is never flagged.
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
	{ kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
	{ kind: "API key (sk-…)", re: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{24,}/ },
	{ kind: "Stripe key", re: /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/ },
	{ kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
	{ kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
	{ kind: "URL with credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s]+/i },
];

const ASSIGNMENT =
	/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["'`]?([^\s"'`,;)]{8,})/gi;

function looksLikeValue(v: string): boolean {
	if (/^(?:\$\{|\$\(|<|%|process\.env|env\.|os\.environ|secrets\.)/i.test(v)) return false; // references, placeholders
	if (/^[x*.\-_]+$/i.test(v)) return false; // xxxx, ****
	return /[a-z]/i.test(v) && /\d/.test(v);
}

/** Kinds of secrets found in `text` (empty when clean). */
export function findSecrets(text: string): string[] {
	const found = new Set<string>();
	for (const p of PATTERNS) if (p.re.test(text)) found.add(p.kind);
	for (const m of text.matchAll(ASSIGNMENT)) if (looksLikeValue(m[1])) found.add("credential assignment");
	return [...found];
}

export function secretRejection(what: string, kinds: string[]): string {
	return (
		`${what} rejected: it appears to contain a secret (${kinds.join(", ")}). The diary is committed to git, so ` +
		`never record credentials. Describe where it lives instead (e.g. "stored in .env as STRIPE_KEY") and retry.`
	);
}
