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

export class ApprovalNotFoundError extends ApprovalError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found.`, 'NOT_FOUND');
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalConflictError extends ApprovalError {
  constructor(instanceId: string) {
    super(
      `Concurrent modification detected on instance "${instanceId}". The record was updated by another process. Please retry.`,
      'CONFLICT',
    );
    this.name = 'ApprovalConflictError';
  }
}

export class ApprovalForbiddenError extends ApprovalError {
  constructor(message: string) {
    super(message, 'FORBIDDEN');
    this.name = 'ApprovalForbiddenError';
  }
}

export class ApprovalValidationError extends ApprovalError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message, 'VALIDATION');
    this.name = 'ApprovalValidationError';
  }
}

export class ApprovalTemplateNotFoundError extends ApprovalError {
  constructor(name: string) {
    super(`Template "${name}" not found.`, 'TEMPLATE_NOT_FOUND');
    this.name = 'ApprovalTemplateNotFoundError';
  }
}
