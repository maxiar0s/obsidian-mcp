import * as z from "zod";

export const toolErrorCodeSchema = z.enum([
  "VAULT_NOT_FOUND",
  "PATH_REJECTED",
  "ACCESS_DENIED",
  "SYMLINK_NOT_ALLOWED",
  "NOTE_NOT_FOUND",
  "ALREADY_EXISTS",
  "REVISION_CONFLICT",
  "LOCK_TIMEOUT",
  "INVALID_FRONTMATTER",
  "INVALID_ENCODING",
  "INVALID_CURSOR",
  "INPUT_TOO_LARGE",
  "TRANSACTION_FAILED",
  "PERMISSION_DENIED",
  "FILESYSTEM_ERROR",
  "INVALID_ARGUMENT"
]);

export const publicToolErrorSchema = z
  .object({
    code: toolErrorCodeSchema.meta({ description: "Stable machine-readable error code" }),
    message: z.string().min(1).meta({ description: "Actionable explanation for the agent" }),
    retryable: z.boolean().meta({
      description: "Whether retrying after correcting state or waiting may succeed"
    }),
    details: z
      .record(z.string(), z.json())
      .optional()
      .meta({ description: "Safe structured context for diagnosing or correcting the failure" })
  })
  .strict();

export type ToolErrorCode = z.output<typeof toolErrorCodeSchema>;
export type PublicToolError = z.output<typeof publicToolErrorSchema>;
type ToolErrorDetails = NonNullable<PublicToolError["details"]>;

export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details: ToolErrorDetails | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean; details?: ToolErrorDetails; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toPublic(): PublicToolError {
    return publicToolErrorSchema.parse({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details })
    });
  }
}

export function asToolFailure(error: unknown, action: string): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (isNodeError(error)) {
    if (error.code === "ENOENT") {
      return new ToolFailure("NOTE_NOT_FOUND", `The requested note does not exist.`, {
        details: { action }
      });
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return new ToolFailure(
        "PERMISSION_DENIED",
        `Permission was denied while trying to ${action}.`,
        {
          details: { action }
        }
      );
    }
    if (error.code === "EEXIST") {
      return new ToolFailure("ALREADY_EXISTS", `The destination already exists.`, {
        details: { action }
      });
    }
  }
  return new ToolFailure("FILESYSTEM_ERROR", `Unable to ${action}.`, {
    retryable: true,
    details: { action },
    cause: error
  });
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
