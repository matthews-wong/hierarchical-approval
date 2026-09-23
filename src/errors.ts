/** Base class for all errors thrown by this library; carries a stable machine-readable `code`. */
export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }

  toJSON(): { code: string; message: string; name: string } {
    return { code: this.code, message: this.message, name: this.name };
  }

  toHttpStatus(): number {
    const map: Record<string, number> = {
      NOT_FOUND: 404,
      CONFLICT: 409,
      FORBIDDEN: 403,
      VALIDATION: 422,
      TEMPLATE_NOT_FOUND: 404,
    };
    return map[this.code] ?? 500;
  }
}

/** Thrown when a requested resource (instance, template, etc.) does not exist. */
export class ApprovalNotFoundError extends ApprovalError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found.`, 'NOT_FOUND');
    this.name = 'ApprovalNotFoundError';
  }
}

/** Thrown when an instance was modified by another process since it was last read. */
export class ApprovalConflictError extends ApprovalError {
  constructor(instanceId: string) {
    super(
      `Concurrent modification detected on instance "${instanceId}". The record was updated by another process. Please retry.`,
      'CONFLICT',
    );
    this.name = 'ApprovalConflictError';
  }
}

/** Thrown when the caller is not authorized to perform the requested action. */
export class ApprovalForbiddenError extends ApprovalError {
  constructor(message: string) {
    super(message, 'FORBIDDEN');
    this.name = 'ApprovalForbiddenError';
  }
}

/** Thrown when input or configuration fails validation; `cause` may hold the originating error. */
export class ApprovalValidationError extends ApprovalError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message, 'VALIDATION');
    this.name = 'ApprovalValidationError';
  }
}

/** Thrown when a template lookup by name finds no registered template. */
export class ApprovalTemplateNotFoundError extends ApprovalError {
  constructor(name: string) {
    super(`Template "${name}" not found.`, 'TEMPLATE_NOT_FOUND');
    this.name = 'ApprovalTemplateNotFoundError';
  }
}
