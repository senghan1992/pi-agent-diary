import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { appendEntry, commitDigest, ensureDiary, findSecrets, readTarget, writeCuratedDoc } from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

// Built at runtime so this file itself doesn't trip secret scanners.
const fake = {
	aws: `AKIA${"ABCDEFGHIJ234567"}`,
	github: `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`,
	sk: `sk-ant-${"api03-abcDEF123456ghiJKL789"}`,
	slack: `xoxb-${"123456789012-abcdefABCDEF"}`,
	google: `AIza${"SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"}`,
	jwt: `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N"}`,
	pem: `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
};

describe("findSecrets", () => {
	test("detects common credential formats", () => {
		for (const [name, value] of Object.entries(fake)) assert.notDeepEqual(findSecrets(`config uses ${value} here`), [], name);
		assert.deepEqual(findSecrets("DATABASE_URL=postgres://app:s3cretPw@db.internal:5432/app"), ["URL with credentials"]);
		assert.deepEqual(findSecrets('api_key: "a8f3k29dk3lq"'), ["credential assignment"]);
		assert.deepEqual(findSecrets("PASSWORD=hunter22"), ["credential assignment"]);
	});

	test("ordinary engineering prose is not flagged", () => {
		for (const text of [
			"Fix token refresh race in auth middleware",
			"API key rotation now runs nightly; keys live in Vault",
			"password: required field, min length 12",
			"secret: ${{ secrets.NPM_TOKEN }}",
			"api_key = process.env.STRIPE_KEY",
			"password=<your password>",
			"token: xxxxxxxxxxxx",
			"stored in .env as STRIPE_KEY",
			"https://example.com/docs/auth",
			"git@github.com:org/repo.git",
			"비밀번호 재설정 메일 템플릿 수정, 토큰 만료 30분",
			"sk-learn 대신 직접 구현",
		]) {
			assert.deepEqual(findSecrets(text), [], text);
		}
	});
});

describe("writes containing secrets are rejected without echoing them", () => {
	test("journal entry", () => {
		const root = tmpProject();
		const r = appendEntry(root, config(), { title: "Set up deploy", issues: [`used ${fake.github} temporarily`] });
		assert.equal(r.ok, false);
		assert.match(r.message, /GitHub token/);
		assert.ok(!r.message.includes(fake.github), "value never echoed");
		assert.equal(existsSync(join(root, ".ad")), false, "nothing written");
	});

	test("PROJECT/STATUS and digests", () => {
		const root = tmpProject();
		ensureDiary(root);
		const r = writeCuratedDoc(root, config(), "project", `# P\n- DB: postgres://app:s3cretPw@db:5432/app`);
		assert.equal(r.ok, false);
		assert.doesNotMatch(readTarget(root, "project"), /s3cretPw/);
		appendEntry(root, config(), { title: "old" }, at(2025, 1, 2));
		const d = commitDigest(root, config(), "2025-01", { headline: "h", digest: `## Outcomes\n- key ${fake.aws}`, pin: [], supersede: [] });
		assert.equal(d.ok, false);
		assert.match(d.message, /AWS access key/);
	});
});
