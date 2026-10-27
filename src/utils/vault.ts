import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { INTERNAL_DIRECTORY, MAX_CONTENT_BYTES, RESERVED_ROOTS } from "../constants.js";
import { argsForDisplay, UserFacingError } from "./diagnostics.js";
import { asToolFailure, isNodeError, ToolFailure } from "./errors.js";
import { sha256 } from "./hash.js";

export { sha256 } from "./hash.js";

export interface VaultDefinition {
  id: string;
  root: string;
  deniedFolders?: readonly string[];
}

export interface ResolvedVault {
  id: string;
  root: string;
  stateRoot: string;
  deniedFolders?: readonly string[];
}

export interface VaultEntry {
  relativePath: string;
  absolutePath: string;
}

const vaultIdPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const windowsAbsolutePattern = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class VaultRegistry {
  private constructor(private readonly vaults: ReadonlyMap<string, ResolvedVault>) {}

  static async create(definitions: readonly VaultDefinition[]): Promise<VaultRegistry> {
    if (definitions.length === 0) throw new Error("At least one --vault is required.");
    const byId = new Map<string, ResolvedVault>();

    for (const definition of definitions) {
      if (!vaultIdPattern.test(definition.id)) {
        throw configurationError(
          "INVALID_VAULT_ID",
          "A configured vault id is invalid.",
          definition.id,
          [
            "Use 1-64 lowercase letters, numbers, underscores, or hyphens, beginning with a letter.",
            `Example: ${argsForDisplay(["serve", "--vault", `notes=${definition.root}`])}`
          ]
        );
      }
      if (byId.has(definition.id)) {
        throw configurationError(
          "DUPLICATE_VAULT_ID",
          "Every configured vault must have a unique id.",
          definition.id,
          `Rename one --vault id; for example, use '${definition.id}-2'.`
        );
      }
      if (!path.isAbsolute(definition.root)) {
        throw configurationError(
          "VAULT_PATH_NOT_ABSOLUTE",
          `Vault '${definition.id}' does not use an absolute path.`,
          definition.root,
          `Replace it with: ${argsForDisplay(["--vault", `${definition.id}=${path.resolve(definition.root)}`])}`
        );
      }

      let root: string;
      try {
        root = await fs.realpath(definition.root);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw configurationError(
            "VAULT_PATH_NOT_FOUND",
            `The configured path for vault '${definition.id}' does not exist.`,
            definition.root,
            [
              "Correct the path in the MCP server configuration.",
              `Expected argument form: ${argsForDisplay(["--vault", `${definition.id}=/correct/absolute/path`])}`
            ],
            error
          );
        }
        throw configurationError(
          "VAULT_PATH_UNREADABLE",
          `The configured path for vault '${definition.id}' could not be resolved.`,
          definition.root,
          "Check directory permissions and confirm that every parent directory is accessible.",
          error
        );
      }
      let stat;
      try {
        stat = await fs.stat(root);
      } catch (error) {
        throw configurationError(
          "VAULT_PATH_UNREADABLE",
          `The configured path for vault '${definition.id}' could not be inspected.`,
          root,
          "Check directory permissions and filesystem availability, then restart the MCP client.",
          error
        );
      }
      if (!stat.isDirectory()) {
        throw configurationError(
          "VAULT_PATH_NOT_DIRECTORY",
          `The configured path for vault '${definition.id}' is not a directory.`,
          root,
          "Select the Obsidian vault directory rather than a file inside it."
        );
      }
      const obsidian = path.join(root, ".obsidian");
      if (!(await isDirectory(obsidian))) {
        throw configurationError(
          "VAULT_NOT_INITIALIZED",
          `Vault '${definition.id}' does not contain an .obsidian directory.`,
          root,
          [
            "Open this directory as a vault in Obsidian and wait for it to initialize.",
            "Then restart the MCP client."
          ]
        );
      }
      try {
        await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
      } catch (error) {
        throw configurationError(
          "VAULT_PERMISSION_DENIED",
          `Vault '${definition.id}' is not readable and writable by this process.`,
          root,
          "Grant the MCP client read and write access to the vault, then restart it.",
          error
        );
      }
      byId.set(definition.id, {
        id: definition.id,
        root,
        stateRoot: path.join(root, INTERNAL_DIRECTORY),
        ...(definition.deniedFolders === undefined
          ? {}
          : {
              deniedFolders: Object.freeze(
                await resolveDeniedFolders(root, definition.deniedFolders)
              )
            })
      });
    }

    const roots = [...byId.values()];
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        const a = roots[left];
        const b = roots[right];
        if (
          a !== undefined &&
          b !== undefined &&
          (contains(a.root, b.root) || contains(b.root, a.root))
        ) {
          throw configurationError(
            "VAULT_ROOTS_OVERLAP",
            "Configured vault roots overlap because they are duplicates or nested inside each other.",
            [`${a.id}: ${a.root}`, `${b.id}: ${b.root}`],
            "Remove one overlapping --vault argument or configure two independent vault roots."
          );
        }
      }
    }
    return new VaultRegistry(byId);
  }

  get(id: string): ResolvedVault {
    const vault = this.vaults.get(id);
    if (vault === undefined) {
      throw new ToolFailure("VAULT_NOT_FOUND", `Vault '${id}' is not configured.`, {
        details: { available_vaults: this.ids() }
      });
    }
    return vault;
  }

  ids(): string[] {
    return [...this.vaults.keys()].sort();
  }

  values(): ResolvedVault[] {
    return [...this.vaults.values()];
  }
}

function configurationError(
  code: string,
  problem: string,
  detected: string | readonly string[],
  fix: string | readonly string[],
  cause?: unknown
): UserFacingError {
  return new UserFacingError(
    {
      code,
      problem,
      detected,
      fix,
      verify: "Run the same configuration with 'obsidian-mcp doctor' after applying the fix.",
      helpAnchor: "vault-configuration-errors"
    },
    1,
    cause === undefined ? undefined : { cause }
  );
}

export class VaultFs {
  constructor(readonly vault: ResolvedVault) {}

  normalizeRelative(
    input: string,
    options: { markdown?: boolean; allowRoot?: boolean } = {}
  ): string {
    if (
      input.includes("\0") ||
      input.includes("\\") ||
      path.isAbsolute(input) ||
      windowsAbsolutePattern.test(input)
    ) {
      throw new ToolFailure("PATH_REJECTED", "Path must be a portable vault-relative path.");
    }
    let value = input;
    if (options.markdown === true && !value.toLowerCase().endsWith(".md")) value += ".md";
    const parts = value.split("/");
    if (
      (value.length === 0 && options.allowRoot !== true) ||
      parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new ToolFailure("PATH_REJECTED", "Path cannot be empty or contain dot segments.");
    }
    const first = parts[0]?.toLowerCase();
    if (first !== undefined && RESERVED_ROOTS.has(first)) {
      throw new ToolFailure("PATH_REJECTED", `The '${first}' directory is reserved.`);
    }
    const normalized = parts.join("/");
    assertVaultPathAllowed(this.vault, path.join(this.vault.root, ...parts));
    return normalized;
  }

  async resolveExisting(
    relativePath: string,
    options: { markdown?: boolean } = {}
  ): Promise<VaultEntry> {
    const normalized = this.normalizeRelative(relativePath, options);
    const absolutePath = path.join(this.vault.root, ...normalized.split("/"));
    await this.assertComponentsSafe(absolutePath, true);
    return { relativePath: normalized, absolutePath };
  }

  async resolveNew(
    relativePath: string,
    options: { markdown?: boolean } = {}
  ): Promise<VaultEntry> {
    const normalized = this.normalizeRelative(relativePath, options);
    const absolutePath = path.join(this.vault.root, ...normalized.split("/"));
    await this.assertComponentsSafe(absolutePath, false);
    return { relativePath: normalized, absolutePath };
  }

  async exists(relativePath: string, options: { markdown?: boolean } = {}): Promise<boolean> {
    try {
      await this.resolveExisting(relativePath, options);
      return true;
    } catch (error) {
      if (error instanceof ToolFailure && error.code === "NOTE_NOT_FOUND") return false;
      throw error;
    }
  }

  async readBytes(entry: VaultEntry): Promise<Buffer> {
    await this.assertComponentsSafe(entry.absolutePath, true);
    try {
      const bytes = await fs.readFile(entry.absolutePath);
      if (bytes.byteLength > MAX_CONTENT_BYTES) {
        throw new ToolFailure("INPUT_TOO_LARGE", "Note exceeds the 5 MiB read limit.");
      }
      return bytes;
    } catch (error) {
      throw asToolFailure(error, "read the note");
    }
  }

  async readText(entry: VaultEntry): Promise<{ bytes: Buffer; text: string; etag: string }> {
    const bytes = await this.readBytes(entry);
    try {
      return { bytes, text: utf8Decoder.decode(bytes), etag: sha256(bytes) };
    } catch (error) {
      throw new ToolFailure("INVALID_ENCODING", "The note is not valid UTF-8.", { cause: error });
    }
  }

  async listMarkdown(scope = ""): Promise<VaultEntry[]> {
    const start =
      scope === ""
        ? { relativePath: "", absolutePath: this.vault.root }
        : await this.resolveExisting(scope);
    const output: VaultEntry[] = [];
    await this.walk(start.absolutePath, output);
    output.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
    return output;
  }

  private async walk(directory: string, output: VaultEntry[]): Promise<void> {
    const handle = await fs.opendir(directory);
    for await (const dirent of handle) {
      if (dirent.name.startsWith(".")) continue;
      const absolutePath = path.join(directory, dirent.name);
      if (isDeniedPath(this.vault, path.relative(this.vault.root, absolutePath))) continue;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        await this.walk(absolutePath, output);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".md")) {
        output.push({
          absolutePath,
          relativePath: path.relative(this.vault.root, absolutePath).split(path.sep).join("/")
        });
      }
    }
  }

  private async assertComponentsSafe(target: string, requireTarget: boolean): Promise<void> {
    assertVaultPathAllowed(this.vault, target);
    if (!contains(this.vault.root, target)) {
      throw new ToolFailure("PATH_REJECTED", "Path resolves outside the configured vault.");
    }
    const relative = path.relative(this.vault.root, target);
    let current = this.vault.root;
    const components = relative === "" ? [] : relative.split(path.sep);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (component === undefined) continue;
      current = path.join(current, component);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new ToolFailure(
            "SYMLINK_NOT_ALLOWED",
            "Symlinks and junctions are not allowed in tool paths."
          );
        }
        if (this.vault.deniedFolders?.length) {
          assertVaultPathAllowed(this.vault, await fs.realpath(current));
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          if (requireTarget) {
            throw new ToolFailure("NOTE_NOT_FOUND", "The requested path does not exist.");
          }
          return;
        }
        throw error;
      }
    }
  }
}

export function normalizeDeniedFolder(input: string): string {
  const parts = input.split("/");
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    input.includes(":") ||
    path.isAbsolute(input) ||
    windowsAbsolutePattern.test(input) ||
    parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part)) ||
    RESERVED_ROOTS.has(parts[0]?.toLowerCase() ?? "")
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      "Denied folders must be portable vault-relative directory paths without dot segments or reserved roots."
    );
  }
  return parts.join("/");
}

async function resolveDeniedFolders(root: string, folders: readonly string[]): Promise<string[]> {
  const output = new Set<string>();
  for (const folder of folders) {
    const normalized = normalizeDeniedFolder(folder);
    output.add(normalized);
    try {
      const real = await fs.realpath(path.join(root, ...normalized.split("/")));
      if (contains(root, real)) output.add(path.relative(root, real).split(path.sep).join("/"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return [...output];
}

export function isDeniedPath(vault: ResolvedVault, relativePath: string): boolean {
  // Conservative matching also covers case and trailing-dot/space aliases on Windows.
  const key = (value: string): string =>
    value
      .split(/[\\/]/u)
      .map((part) =>
        part
          .normalize("NFC")
          .toLowerCase()
          .replace(/[. ]+$/u, "")
      )
      .join("/");
  const candidate = key(relativePath);
  return (
    vault.deniedFolders?.some((folder) => {
      const denied = key(folder);
      return candidate === denied || candidate.startsWith(`${denied}/`);
    }) ?? false
  );
}

export function assertVaultPathAllowed(vault: ResolvedVault, target: string): void {
  if (!contains(vault.root, target)) {
    throw new ToolFailure("PATH_REJECTED", "Path resolves outside the configured vault.");
  }
  if (isDeniedPath(vault, path.relative(vault.root, target))) {
    throw new ToolFailure(
      "ACCESS_DENIED",
      "Access to this path is restricted by the vault configuration."
    );
  }
}

export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
