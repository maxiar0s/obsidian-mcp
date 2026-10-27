import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Logger } from "../src/utils/logger.js";
import { TransactionManager } from "../src/utils/transaction.js";
import { VaultRegistry, sha256 } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

async function lockFixture() {
  const root = await createVault();
  const vault = (await VaultRegistry.create([{ id: "test", root }])).get("test");
  const lock = path.join(vault.stateRoot, "locks", "write");
  await fs.mkdir(lock, { recursive: true });
  const manager = new TransactionManager(
    vault,
    { recoveryDays: 30, recoveryMaxBytes: 1048576 },
    new Logger("error")
  );
  return { vault, lock, manager };
}

test("startup recovers an abandoned empty lock without altering notes", async () => {
  const { vault, lock, manager } = await lockFixture();
  const note = path.join(vault.root, "note.md");
  await fs.writeFile(note, "unchanged");
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  await manager.initialize();
  assert.equal(await fs.readFile(note, "utf8"), "unchanged");
  await assert.rejects(() => fs.access(lock));
});

test("a fresh empty lock receives the creation grace period", async () => {
  const { lock, manager } = await lockFixture();
  const started = Date.now();
  await manager.initialize();
  assert.ok(Date.now() - started >= 900);
  await assert.rejects(() => fs.access(lock));
});

test("startup retries if its empty directory disappears before ownership is published", async () => {
  const { lock, manager } = await lockFixture();
  await fs.rmdir(lock);
  const original = fs.writeFile;
  let removed = false;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    if (!removed && String(args[0]) === path.join(lock, "owner.json")) {
      removed = true;
      await fs.rmdir(lock);
    }
    return original(...args);
  }) as typeof fs.writeFile;
  try {
    await manager.initialize();
    assert.equal(removed, true);
    await assert.rejects(() => fs.access(lock));
  } finally {
    fs.writeFile = original;
  }
});

test("empty-lock recovery cannot remove an owner published after its age check", async () => {
  const { lock, manager } = await lockFixture();
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  const ownerPath = path.join(lock, "owner.json");
  const owner = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  const original = fs.rmdir;
  let published = false;
  fs.rmdir = (async (...args: Parameters<typeof fs.rmdir>) => {
    if (!published && String(args[0]) === lock) {
      published = true;
      await fs.writeFile(ownerPath, owner);
    }
    return original(...args);
  }) as typeof fs.rmdir;
  const pending = manager.initialize();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(published, true);
    assert.equal(await fs.readFile(ownerPath, "utf8"), owner);
  } finally {
    fs.rmdir = original;
    await fs.rm(lock, { recursive: true });
    await pending;
  }
});

test("startup waits for a fresh lock owner and never steals an active lock", async () => {
  const { vault, lock, manager } = await lockFixture();
  const pending = manager.initialize();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const owner = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  await fs.writeFile(path.join(lock, "owner.json"), owner);
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await fs.readFile(path.join(lock, "owner.json"), "utf8"), owner);
  assert.deepEqual(await fs.readdir(path.join(vault.stateRoot, "transactions")), []);
  await fs.rm(lock, { recursive: true });
  await pending;
});

test("unverifiable nonempty locks are preserved and reported clearly", async () => {
  await Promise.all(
    ["unknown", "{", "", "null", '{"pid":0}', '{"pid":"123"}'].map(async (value) => {
      const { vault, lock, manager } = await lockFixture();
      const metadata = path.join(lock, value === "unknown" ? "unexpected.txt" : "owner.json");
      await fs.writeFile(metadata, value);
      const note = path.join(vault.root, "note.md");
      await fs.writeFile(note, "unchanged");
      const old = new Date(Date.now() - 60000);
      await fs.utimes(lock, old, old);
      await assert.rejects(
        () => manager.initialize(),
        (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error);
          assert.equal(error.code, "LOCK_TIMEOUT");
          assert.match(error.message, /owner metadata/u);
          return true;
        }
      );
      assert.equal(await fs.readFile(metadata, "utf8"), value);
      assert.equal(sha256(await fs.readFile(note)), sha256("unchanged"));
    })
  );
});

test("independent processes recover one empty lock without overlapping startup writes", async () => {
  const { vault, lock } = await lockFixture();
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  const transactionModule = pathToFileURL(path.resolve("src/utils/transaction.ts")).href;
  const loggerModule = pathToFileURL(path.resolve("src/utils/logger.ts")).href;
  const script = `
    import { promises as fs } from 'node:fs';
    import path from 'node:path';
    import { TransactionManager } from ${JSON.stringify(transactionModule)};
    import { Logger } from ${JSON.stringify(loggerModule)};
    const vault = ${JSON.stringify(vault)};
    const original = fs.readdir;
    let inspected = false;
    fs.readdir = async (...args) => {
      if (!inspected && String(args[0]) === path.join(vault.stateRoot, 'transactions')) {
        inspected = true;
        const marker = path.join(vault.root, 'exclusive-probe');
        const handle = await fs.open(marker, 'wx');
        try { await new Promise(resolve => setTimeout(resolve, 80)); }
        finally { await handle.close(); await fs.unlink(marker); }
      }
      return original(...args);
    };
    const write = fs.writeFile;
    fs.writeFile = async (...args) => {
      if (!String(args[0]).includes('manifest.json')) return write(...args);
      const marker = path.join(vault.root, 'exclusive-probe');
      const handle = await fs.open(marker, 'wx');
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        return await write(...args);
      } finally { await handle.close(); await fs.unlink(marker); }
    };
    const manager = new TransactionManager(vault, { recoveryDays: 30, recoveryMaxBytes: 1048576 }, new Logger('error'));
    await manager.initialize();
    await manager.run([{kind: 'write', path: path.join(vault.root, process.argv[1] + '.md'), data: Buffer.from('ok'), requireMissing: true}]);
  `;
  await Promise.all(
    Array.from(
      { length: 4 },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", script, String(index)],
            { stdio: ["ignore", "ignore", "pipe"] }
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        })
    )
  );
  await assert.rejects(() => fs.access(lock));
  await assert.rejects(() => fs.access(path.join(vault.root, "exclusive-probe")));
  for (let index = 0; index < 4; index += 1) {
    assert.equal(await fs.readFile(path.join(vault.root, `${index}.md`), "utf8"), "ok");
  }
});

test("transaction commits multiple files and records recoverable revisions", async () => {
  const root = await createVault();
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const realRoot = registry.get("test").root;
  const first = path.join(realRoot, "first.md");
  const second = path.join(realRoot, "second.md");
  await fs.writeFile(first, "before");
  const manager = new TransactionManager(
    registry.get("test"),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();
  const id = await manager.run([
    { kind: "write", path: first, data: Buffer.from("after"), expectedEtag: sha256("before") },
    { kind: "write", path: second, data: Buffer.from("new"), requireMissing: true }
  ]);
  assert.equal(await fs.readFile(first, "utf8"), "after");
  assert.equal(await fs.readFile(second, "utf8"), "new");
  assert.ok(
    (await manager.listRecovery()).some((entry) => entry.id === id && entry.state === "committed")
  );
});

test("transaction preflight prevents partial changes", async () => {
  const root = await createVault();
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const realRoot = registry.get("test").root;
  const first = path.join(realRoot, "first.md");
  const second = path.join(realRoot, "second.md");
  await fs.writeFile(first, "before");
  await fs.writeFile(second, "exists");
  const manager = new TransactionManager(
    registry.get("test"),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();
  await assert.rejects(() =>
    manager.run([
      { kind: "write", path: first, data: Buffer.from("changed"), expectedEtag: sha256("before") },
      { kind: "write", path: second, data: Buffer.from("overwrite"), requireMissing: true }
    ])
  );
  assert.equal(await fs.readFile(first, "utf8"), "before");
  assert.equal(await fs.readFile(second, "utf8"), "exists");
  assert.deepEqual(await fs.readdir(path.join(realRoot, ".obsidian-mcp", "transactions")), []);
});

test("startup recovery restores only journal entries that may have applied", async () => {
  const root = await createVault();
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const vault = registry.get("test");
  const changed = path.join(vault.root, "changed.md");
  const untouched = path.join(vault.root, "untouched.md");
  await fs.writeFile(changed, "planned");
  await fs.writeFile(untouched, "external edit");

  const id = "11111111-1111-4111-8111-111111111111";
  const transactionRoot = path.join(vault.stateRoot, "transactions", id);
  await fs.mkdir(transactionRoot, { recursive: true });
  await fs.writeFile(path.join(transactionRoot, "0.bin"), "original");
  await fs.writeFile(
    path.join(transactionRoot, "manifest.json"),
    JSON.stringify({
      id,
      state: "committing",
      createdAt: new Date().toISOString(),
      snapshots: [
        {
          path: "changed.md",
          operation: "write",
          phase: "applying",
          existed: true,
          etag: sha256("original"),
          plannedEtag: sha256("planned"),
          snapshot: "0.bin",
          recoverable: true
        },
        {
          path: "untouched.md",
          operation: "write",
          phase: "pending",
          existed: true,
          etag: sha256("before"),
          plannedEtag: sha256("never written"),
          snapshot: "1.bin",
          recoverable: true
        }
      ]
    })
  );
  await fs.writeFile(path.join(transactionRoot, "1.bin"), "before");

  const manager = new TransactionManager(
    vault,
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();

  assert.equal(await fs.readFile(changed, "utf8"), "original");
  assert.equal(await fs.readFile(untouched, "utf8"), "external edit");
  assert.equal(
    (await manager.listRecovery()).find((entry) => entry.id === id)?.state,
    "rolled_back"
  );
});

test("completed transaction can be restored when committed files are unchanged", async () => {
  const root = await createVault();
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const target = path.join(registry.get("test").root, "note.md");
  await fs.writeFile(target, "before");
  const manager = new TransactionManager(
    registry.get("test"),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();
  const original = await manager.run([
    { kind: "write", path: target, data: Buffer.from("after"), expectedEtag: sha256("before") }
  ]);
  const recovery = await manager.restoreRecovery(original);
  assert.notEqual(recovery, original);
  assert.equal(await fs.readFile(target, "utf8"), "before");
});

test("recursive directory creation and recovery are one journaled transaction", async () => {
  const root = await createVault();
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const vault = registry.get("test");
  const parent = path.join(vault.root, "parent");
  const child = path.join(parent, "child");
  const manager = new TransactionManager(
    vault,
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();

  const id = await manager.run([
    { kind: "mkdir", path: parent },
    { kind: "mkdir", path: child }
  ]);
  assert.equal((await fs.stat(child)).isDirectory(), true);
  await manager.restoreRecovery(id);
  await assert.rejects(() => fs.access(parent));
});
