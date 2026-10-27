# Obsidian MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets MCP-compatible assistants safely read and modify explicitly configured Obsidian vaults.

Version 2 supports both MCP `2026-07-28` and 2025-era clients by default, and requires Node.js 22 or newer. It works directly with Markdown files, so Obsidian does not need to be open. Legacy protocol and v1 positional-path compatibility are deprecated and print exact migration instructions to stderr.

> [!IMPORTANT]
> MCP clients can invoke destructive tools. Back up important vaults, review client permission prompts, and use revision preconditions for concurrently edited notes.

## Quick start

Node.js 22 or newer is required:

```bash
node --version # v22 or newer
```

Run with `npx` without installing the package globally. Pinning the major version receives compatible 2.x updates without automatically crossing a future major version:

```bash
npx -y obsidian-mcp@2 serve --vault notes=/absolute/path/to/vault
```

Configure an MCP client to launch the same command over stdio:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp@2", "serve", "--vault", "notes=/absolute/path/to/vault"]
    }
  }
}
```

Alternatively, install the package globally and use `"command": "obsidian-mcp"` with the same arguments beginning at `"serve"`:

```bash
npm install -g obsidian-mcp@2
```

Each vault must already contain an `.obsidian` directory and must be configured using an absolute path.

Both protocol eras are served from the same tool definitions. After confirming that your MCP client negotiates `2026-07-28`, you may opt into modern-only mode by adding `"--legacy", "reject"` to `args`.

Vault ids use lowercase letters, digits, `_`, and `-`, must begin with a letter, and are the values assistants pass to tools. Up to ten vaults may be configured. Repeat `--vault` to expose more than one vault:

```bash
obsidian-mcp serve \
  --vault work=/Users/me/Documents/WorkVault \
  --vault personal=/Users/me/Documents/PersonalVault
```

Network, removable, hidden, and synced locations are allowed because an explicit `--vault` is treated as authorization; the same containment protections apply to every location.

### Restrict folders within a vault

Repeat `--deny-folder <vault-id>=<relative/folder>` to hide folders and their descendants from this MCP server:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "obsidian-mcp",
      "args": [
        "serve",
        "--vault",
        "notes=C:/Obsidian/MyVault",
        "--deny-folder",
        "notes=Private",
        "--deny-folder",
        "notes=Work/Confidential"
      ]
    }
  }
}
```

Paths are relative to the specified vault and use `/`, including on Windows. Rules apply only to that vault, may precede `--vault`, and can name folders that do not exist yet. Invalid rules or unknown vault ids prevent startup. Absolute paths, backslashes, dot segments, trailing dots/spaces, and reserved roots are rejected. Rules match whole path segments, conservatively ignoring case and Unicode normalization: `Private` also blocks `private`, but not `Private-other`. Without this option, existing access is unchanged.

Direct reads, writes, directory creation, moves, deletion, and tag changes return `ACCESS_DENIED`. Searches and vault-wide tag/backlink operations skip restricted subtrees without opening them. Links in restricted notes are therefore not updated when an allowed note moves or is deleted.

Use the same rules for `doctor`, `recovery list`, and `recovery restore`. Recovery cannot restore restricted paths; an incomplete transaction targeting one prevents startup without restoring any path in that transaction. Resolve such recovery manually with the server stopped. Rules are startup configuration, not agent-changeable tool arguments; restart the MCP server after changing them.

This is an MCP access restriction, **not an operating-system sandbox**. It cannot block another tool, terminal, or process from accessing files, nor redact sensitive text or hard-linked copies already present in allowed notes. Use filesystem permissions or process isolation for that stronger boundary.

## Design principles

- Vault access is explicitly allowlisted at process startup.
- Every tool path is vault-relative, segment-checked, and blocked from symlinks and reserved state.
- File mutations are journaled, conflict-checked, atomically replaced, and rolled back as one transaction.
- The server never listens on a network interface or sends telemetry.
- stdout is reserved exclusively for MCP messages; structured diagnostics go to stderr.
- Results are bounded, paginated where appropriate, and available as both text and structured content.

## Tools

| Tool                        | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `obsidian_list_vaults`      | List configured vault ids without exposing host paths.                        |
| `obsidian_read_note`        | Read a bounded page of a note and return its SHA-256 `etag`.                  |
| `obsidian_create_note`      | Atomically create a note without overwriting.                                 |
| `obsidian_edit_note`        | Append, prepend, or replace exact note content.                               |
| `obsidian_delete_note`      | Move a note to MCP trash or permanently delete it with explicit confirmation. |
| `obsidian_move_note`        | Move or rename a note and update unambiguous backlinks transactionally.       |
| `obsidian_create_directory` | Transactionally create a directory inside a vault.                            |
| `obsidian_search_vault`     | Search content, filenames, or tags with bounded cursor pagination.            |
| `obsidian_add_tags`         | Add tags to one or more notes atomically.                                     |
| `obsidian_remove_tags`      | Remove exact, nested, or wildcard-selected tags atomically.                   |
| `obsidian_rename_tag`       | Rename a tag across the vault atomically.                                     |
| `obsidian_manage_tags`      | Unified add/remove tag workflow using the same implementation.                |

All schemas are strict JSON Schema 2020-12 contracts generated from Zod. Mutating results include a transaction id; tool failures return `isError: true` with an actionable error code.

### Reading and concurrency

`obsidian_read_note` returns an `etag`. Pass it as `if_match` to edit, move, or delete when avoiding lost updates matters. Batch tag operations accept an `expected_etags` map. A changed note returns `REVISION_CONFLICT` rather than being overwritten.

Large notes are paginated using an opaque cursor bound to the path and `etag`. Search uses an opaque cursor bound to the query and options. Tool text responses are capped at 25,000 characters.

### Deletion and recovery

Trash is the default. Deleted note bytes and metadata are stored separately under `.obsidian-mcp/trash`; metadata is never injected into the note. Permanent deletion requires `confirm_path` to exactly match the canonical relative path.

Transactions and recovery snapshots live in `.obsidian-mcp/transactions`. Completed data is retained for 30 days and pruned oldest-first above 1 GiB by default:

```bash
obsidian-mcp serve --vault work=/path \
  --recovery-days 14 \
  --recovery-max-bytes 536870912
```

Inspect or restore a completed transaction while the MCP server is stopped:

```bash
obsidian-mcp recovery list --vault work=/path
obsidian-mcp recovery restore --vault work=/path --id <transaction-id>
```

Recovery refuses to overwrite content changed since the selected transaction. Permanent deletion snapshots are purged after commit and cannot be restored.

## Path and filesystem safety

The server:

- canonicalizes configured vault roots and rejects duplicate or nested roots;
- rejects absolute, UNC, Windows-drive, NUL, backslash, empty, and dot-segment tool paths;
- reserves `.obsidian`, `.obsidian-mcp`, `.git`, `.backup`, and `.trash` from tool access;
- checks existing targets and the nearest existing ancestor for new targets;
- rejects symlinks, junctions, and reparse-point paths, and skips them during scans;
- performs no shell execution for filesystem validation;
- strictly decodes UTF-8 and does not silently replace invalid bytes.

The process needs read and write access to each configured vault. `obsidian-mcp doctor --vault id=/path` validates startup readiness and recovery state.

## Link and tag behavior

Moves recognize Obsidian Wikilinks, embeds, Markdown links, aliases, URL-encoded destinations, headings, and block anchors. A link is rewritten only when it resolves unambiguously to the source note; ambiguous links are reported and left unchanged. Deletion preserves backlinks unless `backlink_action: "mark_broken"` is requested.

Tags follow Obsidian's case-insensitive rules and support Unicode, emoji, `_`, `-`, `/`, and nested tags. Frontmatter tags are written as YAML lists. Inline tag processing ignores fenced/inline code and HTML comments. Wildcards use a bounded matcher rather than regular expressions.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run ci
```

Each tool owns a typed definition under `src/tools/<tool>/index.ts`; the small registry in `src/tools/index.ts` applies shared MCP registration and response behavior. Filesystem, transaction, Markdown, link, and search behavior live in reusable utilities. A new tool must use `VaultFs` for every path, `TransactionManager` for mutations, strict input/output schemas, structured results, annotations, and security/integration tests.

See [MIGRATING.md](MIGRATING.md) for the 1.x migration and [SECURITY.md](SECURITY.md) for vulnerability reporting.

Startup errors and compatibility warnings are written only to stderr with a stable code, the detected problem, an exact fix, a verification step, and a link to the matching migration section. If the server does not appear, find the code in the MCP client logs and use the [diagnostic reference](MIGRATING.md#diagnostic-reference).

## License

MIT
