import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../config-store.js";
import { DpapiCredentialStore } from "../credential-store.js";

test("Windows DPAPI CurrentUser 加密凭证且不写明文", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agent-dpapi-"));
  const store = new ConfigStore(root, { secureDirectory: false });
  const credentials = new DpapiCredentialStore(store);
  const plaintext = `agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await credentials.selfTest();
    await credentials.saveCredential(plaintext);
    const record = await store.readCredentialRecord();
    assert.equal(record.ciphertext.includes(plaintext), false);
    assert.equal(await credentials.loadCredential(), plaintext);
    assert.equal(fs.readFileSync(store.paths.credentialFile, "utf8").includes(plaintext), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
