// storage unit: traversal/symlink rejection, atomic write/read, cleanup.
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	contentDispositionFor,
	deleteBlob,
	ensureStorageDir,
	readEncryptedFile,
	resolveStoragePath,
	storageKeyFor,
	writeEncryptedFile,
} from "../../src/documents/storage.js";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "docstore-"));
	await ensureStorageDir(root);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("document storage", () => {
	it("writes and reads back byte-for-byte", async () => {
		const key = storageKeyFor(randomUUID(), randomUUID());
		expect(key).toMatch(/^[0-9a-f-]+\/[0-9a-f-]+\.enc$/);
		const bytes = randomBytes(1024);
		await writeEncryptedFile(root, key, bytes);
		expect(await readEncryptedFile(root, key)).toEqual(bytes);
		const st = await fs.stat(path.join(await fs.realpath(root), key));
		expect(st.mode & 0o777).toBeLessThanOrEqual(0o777);
		await deleteBlob(root, key);
		await expect(readEncryptedFile(root, key)).rejects.toThrow();
	});

	it("rejects absolute paths and .. escapes", async () => {
		await expect(resolveStoragePath(root, "/etc/passwd")).rejects.toThrow("invalid storage key");
		await expect(resolveStoragePath(root, "../escape.enc")).rejects.toThrow("invalid storage key");
		await expect(resolveStoragePath(root, "a/../../escape.enc")).rejects.toThrow(
			"invalid storage key",
		);
		await expect(writeEncryptedFile(root, "../escape.enc", Buffer.from("x"))).rejects.toThrow();
	});

	it("rejects symlink escapes out of the storage dir", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "docstore-out-"));
		try {
			const link = path.join(await fs.realpath(root), "shard");
			await fs.symlink(outside, link, "dir");
			await expect(writeEncryptedFile(root, "shard/evil.enc", Buffer.from("x"))).rejects.toThrow(
				"invalid storage key",
			);
			expect(await fs.readdir(outside)).toEqual([]);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("leaves no temp file behind on success or missing-key delete", async () => {
		const key = storageKeyFor(randomUUID(), randomUUID());
		await writeEncryptedFile(root, key, Buffer.from("x"));
		const dir = path.join(await fs.realpath(root), key.split("/")[0]);
		expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
		await deleteBlob(root, storageKeyFor(randomUUID(), randomUUID())); // no throw
	});

	it("builds a safe ASCII-only attachment disposition", () => {
		const id = randomUUID();
		expect(contentDispositionFor(id, "application/pdf")).toBe(
			`attachment; filename="document-${id}.pdf"`,
		);
		expect(contentDispositionFor(id, "image/png")).toContain(".png");
		expect(contentDispositionFor(id, "image/jpeg")).toContain(".jpg");
	});
});
