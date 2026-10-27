# Security policy

## Supported versions

The latest 2.x release is supported. Version 1.x is deprecated and contains known path-containment defects.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting feature for this repository and include:

- affected version and platform;
- a minimal reproduction using a disposable vault;
- expected and observed behavior;
- impact and any known mitigations.

Avoid including real vault contents or personal filesystem paths. Maintainers should acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

## Security boundary

An explicit `--vault id=/absolute/path` grants this local process read/write access to that root. MCP tool paths must remain within it. The server does not authenticate local stdio clients; the launching MCP host controls who can invoke the process and which vault arguments it receives.

Repeat `--deny-folder id=relative/folder` to restrict directories and descendants within a configured vault. Direct access and transaction/recovery targets are denied; recursive searches and global tag/backlink edits skip those subtrees. Matching is segment-aware and conservatively case-insensitive. Keep the same restrictions on every invocation, including recovery commands. The MCP client must restart the server to apply configuration changes.

These rules do not sandbox the process or other agent tools. Allowed notes may already contain copied sensitive text, links, or hard links to restricted content. Concurrent local filesystem modifications can race path checks; use OS-level permissions or isolation when untrusted processes can modify the vault.
