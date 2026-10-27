import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseArguments } from "../src/cli.js";
import { Logger } from "../src/utils/logger.js";
import { TransactionManager } from "../src/utils/transaction.js";
import { VaultFs, VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

const denied = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ACCESS_DENIED";

async function digest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of (await fs.readdir(root)).sort()) {
    const target = path.join(root, name);
    hash.update(name);
    hash.update(
      (await fs.lstat(target)).isDirectory() ? await digest(target) : await fs.readFile(target)
    );
  }
  return hash.digest("hex");
}

test("restricted boundaries, aliases and independent vaults", async () => {
  const a = await createVault();
  const b = await createVault();
  for (const root of [a, b]) {
    for (const folder of ["Private", "Private-other", "Work/Confidential", "Caf\u00e9"]) {
      await fs.mkdir(path.join(root, folder), { recursive: true });
      await fs.writeFile(path.join(root, folder, "Secret.md"), "secret");
    }
  }
  const registry = await VaultRegistry.create([
    {
      id: "notes",
      root: a,
      deniedFolders: ["Private", "Work/Confidential", "Caf\u00e9", "Future/Secret"]
    },
    { id: "other", root: b }
  ]);
  const access = new VaultFs(registry.get("notes"));
  const before = await digest(a);
  for (const candidate of [
    "Private",
    "private/Secret.md",
    "Private./Secret.md",
    "Private /Secret.md",
    "Work/Confidential/Secret.md",
    "Cafe\u0301/Secret.md",
    "Future/Secret/New.md"
  ]) {
    await assert.rejects(() => access.resolveExisting(candidate), denied);
    await assert.rejects(() => access.resolveNew(candidate), denied);
    assert.equal(await digest(a), before);
  }
  assert.deepEqual(
    (await access.listMarkdown()).map((entry) => entry.relativePath),
    ["Private-other/Secret.md"]
  );
  assert.equal((await new VaultFs(registry.get("other")).listMarkdown()).length, 4);
  if (process.platform === "win32") {
    for (const alias of ["Private::$INDEX_ALLOCATION/Secret.md", "Work/CONFID~1/Secret.md"]) {
      try {
        await fs.access(path.join(a, alias));
      } catch {
        continue; // Short names are unavailable on some Windows volumes.
      }
      await assert.rejects(() => access.resolveExisting(alias), denied);
      assert.equal(await digest(a), before);
    }
  }
});

test("restricted recovery rejects before changing any stored bytes", async () => {
  const root = await fs.realpath(await createVault());
  await fs.mkdir(path.join(root, "Private"));
  const hidden = path.join(root, "Private", "Hidden.md");
  const publicPath = path.join(root, "Public.md");
  await fs.writeFile(hidden, "hidden-before");
  await fs.writeFile(publicPath, "public-before");
  const options = { recoveryDays: 30, recoveryMaxBytes: 1048576 };
  const logger = new Logger("error");
  const open = new TransactionManager(
    (await VaultRegistry.create([{ id: "notes", root }])).get("notes"),
    options,
    logger
  );
  await open.initialize();
  const id = await open.run([
    { kind: "write", path: hidden, data: Buffer.from("hidden-after") },
    { kind: "write", path: publicPath, data: Buffer.from("public-after") }
  ]);
  const restricted = new TransactionManager(
    (await VaultRegistry.create([{ id: "notes", root, deniedFolders: ["Private"] }])).get("notes"),
    options,
    logger
  );
  await restricted.initialize();
  const before = await digest(root);
  await assert.rejects(() => restricted.restoreRecovery(id), denied);
  assert.equal(await digest(root), before);
});

test("existing unknown-option suggestion remains unchanged", () => {
  assert.throws(
    () =>
      parseArguments([
        "serve",
        "--vault",
        "notes=C:/vault",
        "--log-level",
        "error",
        "--den-folder",
        "notes=Private"
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "diagnostic" in error);
      const diagnostic = error.diagnostic as { code: string; fix: string[] };
      assert.equal(diagnostic.code, "CLI_UNKNOWN_OPTION");
      assert.deepEqual(diagnostic.fix, [
        "Did you mean '--log-level'?",
        "Run 'obsidian-mcp --help' to list supported options."
      ]);
      return true;
    }
  );
});
