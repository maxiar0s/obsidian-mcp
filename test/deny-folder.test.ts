import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { parseArguments } from "../src/cli.js";
import { ToolFailure } from "../src/utils/errors.js";
import { Logger } from "../src/utils/logger.js";
import { TransactionManager } from "../src/utils/transaction.js";
import { VaultFs, VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

const denied = (error: unknown): boolean =>
  error instanceof ToolFailure && error.code === "ACCESS_DENIED";

test("deny-folder is repeatable, vault-specific and independent of option order", () => {
  for (const command of [
    ["serve"],
    ["doctor"],
    ["recovery", "list"],
    ["recovery", "restore", "--id", "x"]
  ]) {
    const parsed = parseArguments([
      ...command,
      "--deny-folder",
      "notes=Private",
      "--vault",
      "notes=/vault",
      "--vault",
      "other=/other",
      "--deny-folder",
      "notes=Work/Secret"
    ]);
    assert.notEqual(typeof parsed, "string");
    if (typeof parsed === "string") return;
    assert.deepEqual(parsed.vaults[0]?.deniedFolders, ["Private", "Work/Secret"]);
    assert.equal(parsed.vaults[1]?.deniedFolders, undefined);
    assert.ok(parsed.canonicalArgs.includes("notes=Work/Secret"));
  }
  for (const value of [
    "Private",
    "notes=",
    "missing=Private",
    "notes=../Private",
    "notes=/Private",
    "notes=C:/Private",
    "notes=Private\\child",
    "notes=Private//child"
  ]) {
    assert.throws(
      () => parseArguments(["serve", "--vault", "notes=/vault", "--deny-folder", value]),
      undefined,
      value
    );
  }
});

test("denied paths are blocked before reads and omitted from recursive enumeration", async () => {
  const root = await createVault();
  await fs.mkdir(path.join(root, "Private", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "Private-other"));
  await fs.writeFile(path.join(root, "Private", "nested", "secret.md"), "secret");
  await fs.writeFile(path.join(root, "Private-other", "public.md"), "public");
  const registry = await VaultRegistry.create([
    { id: "test", root, deniedFolders: ["Private", "Future/Secret"] }
  ]);
  const vault = registry.get("test");
  const access = new VaultFs(vault);
  for (const candidate of [
    "Private",
    "Private/nested/secret.md",
    "PRIVATE/nested/secret.md",
    "Future/Secret/new.md"
  ]) {
    await assert.rejects(() => access.resolveExisting(candidate), denied);
    await assert.rejects(() => access.resolveNew(candidate), denied);
  }
  await assert.rejects(() => access.listMarkdown("Private"), denied);
  await assert.rejects(
    () =>
      access.readBytes({
        relativePath: "Private/nested/secret.md",
        absolutePath: path.join(vault.root, "Private", "nested", "secret.md")
      }),
    denied
  );
  const original = fs.opendir;
  fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
    assert.doesNotMatch(String(args[0]), /[/\\]Private(?:[/\\]|$)/u);
    return original(...args);
  }) as typeof fs.opendir;
  try {
    assert.deepEqual(
      (await access.listMarkdown()).map((entry) => entry.relativePath),
      ["Private-other/public.md"]
    );
  } finally {
    fs.opendir = original;
  }
  const unrestricted = new VaultFs(
    (await VaultRegistry.create([{ id: "test", root }])).get("test")
  );
  assert.equal((await unrestricted.listMarkdown()).length, 2);
});

test("transactions and recovery respect newly denied folders without partial content changes", async () => {
  const root = await fs.realpath(await createVault());
  await fs.mkdir(path.join(root, "Private"));
  const target = path.join(root, "Private", "secret.md");
  await fs.writeFile(target, "before");
  const options = { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 };
  const logger = new Logger("error");
  const openVault = (await VaultRegistry.create([{ id: "test", root }])).get("test");
  const open = new TransactionManager(openVault, options, logger);
  await open.initialize();
  const id = await open.run([{ kind: "write", path: target, data: Buffer.from("after") }]);
  const vault = (
    await VaultRegistry.create([{ id: "test", root, deniedFolders: ["Private"] }])
  ).get("test");
  const restricted = new TransactionManager(vault, options, logger);
  await restricted.initialize();
  await assert.rejects(() => restricted.restoreRecovery(id), denied);
  const publicPath = path.join(root, "public.md");
  await fs.writeFile(publicPath, "public");
  await assert.rejects(
    () =>
      restricted.run([
        { kind: "write", path: publicPath, data: Buffer.from("changed") },
        { kind: "delete", path: target }
      ]),
    denied
  );
  assert.equal(await fs.readFile(target, "utf8"), "after");
  assert.equal(await fs.readFile(publicPath, "utf8"), "public");
  const transactionRoot = path.join(vault.stateRoot, "transactions", id);
  const manifestPath = path.join(transactionRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.state = "committing";
  manifest.snapshots[0].phase = "applied";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const journalBefore = await fs.readFile(manifestPath, "utf8");
  await assert.rejects(() => restricted.initialize(), denied);
  assert.equal(await fs.readFile(target, "utf8"), "after");
  assert.equal(await fs.readFile(manifestPath, "utf8"), journalBefore);
});

test("MCP denies folder access across tools while search and global edits skip secrets", async () => {
  const root = await createVault();
  await fs.mkdir(path.join(root, "Private"));
  const secret = "secret #old [[Public]]";
  await fs.writeFile(path.join(root, "Private", "Secret.md"), secret);
  await fs.writeFile(path.join(root, "Public.md"), "public #old");
  const client = new Client(
    { name: "deny-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "dist/main.js",
        "serve",
        "--vault",
        `test=${root}`,
        "--deny-folder",
        "test=Private",
        "--log-level",
        "error"
      ],
      stderr: "pipe"
    })
  );
  try {
    const calls: [string, Record<string, unknown>][] = [
      ["obsidian_read_note", { path: "Private/Secret.md" }],
      ["obsidian_create_note", { path: "Private/New", content: "x" }],
      ["obsidian_edit_note", { path: "Private/Secret.md", operation: "append", content: "x" }],
      ["obsidian_delete_note", { path: "Private/Secret.md", mode: "trash" }],
      ["obsidian_move_note", { source: "Private/Secret.md", destination: "Stolen.md" }],
      ["obsidian_move_note", { source: "Public.md", destination: "Private/Stolen.md" }],
      ["obsidian_create_directory", { path: "Private/New" }],
      ["obsidian_add_tags", { paths: ["Private/Secret.md"], tags: ["new"] }],
      ["obsidian_remove_tags", { paths: ["Private/Secret.md"], tags: ["old"] }],
      ["obsidian_manage_tags", { operation: "add", paths: ["Private/Secret.md"], tags: ["new"] }]
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: { vault: "test", ...args } });
      assert.equal(result.isError, true, name);
      assert.equal(
        (result.structuredContent as { error: { code: string } }).error.code,
        "ACCESS_DENIED",
        name
      );
      assert.equal(await fs.readFile(path.join(root, "Private", "Secret.md"), "utf8"), secret);
      assert.equal(await fs.readFile(path.join(root, "Public.md"), "utf8"), "public #old");
    }
    assert.deepEqual(await fs.readdir(path.join(root, "Private")), ["Secret.md"]);
    await assert.rejects(() => fs.access(path.join(root, "Stolen.md")));
    for (const [mode, query] of [
      ["content", "secret"],
      ["filename", "Secret"],
      ["tag", "old"]
    ]) {
      const result = await client.callTool({
        name: "obsidian_search_vault",
        arguments: { vault: "test", mode, query }
      });
      assert.notEqual(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /Private|Secret\.md|secret #old/u);
    }
    for (const [name, args] of [
      ["obsidian_rename_tag", { old_tag: "old", new_tag: "new" }],
      ["obsidian_move_note", { source: "Public.md", destination: "Moved.md" }],
      ["obsidian_delete_note", { path: "Moved.md", backlink_action: "mark_broken" }]
    ] as const) {
      const result = await client.callTool({ name, arguments: { vault: "test", ...args } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(await fs.readFile(path.join(root, "Private", "Secret.md"), "utf8"), secret);
    }
  } finally {
    await client.close();
  }
});
