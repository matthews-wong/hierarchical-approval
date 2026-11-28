import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalError } from '../../src/index.js';

describe('ApprovalError.toHttpStatus', () => {
  it.each([
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['CANNOT_CANCEL', 409],
    ['FORBIDDEN', 403],
    ['VALIDATION', 422],
    ['TEMPLATE_NOT_FOUND', 404],
    ['SCHEDULER_SHUTDOWN', 503],
  ])('maps %s to %i', (code, status) => {
    expect(new ApprovalError('x', code).toHttpStatus()).toBe(status);
  });

  it('returns 500 for an unmapped code', () => {
    expect(new ApprovalError('x', 'UNKNOWN').toHttpStatus()).toBe(500);
  });

  it.each(['', 'not_found', 'Not_Found', ' NOT_FOUND'])(
    'matches codes exactly, so %j yields 500',
    (code) => {
      expect(new ApprovalError('x', code).toHttpStatus()).toBe(500);
    },
  );

  it('does not trim a trailing space, while the exact code still maps', () => {
    expect(new ApprovalError('x', 'NOT_FOUND').toHttpStatus()).toBe(404);
    expect(new ApprovalError('x', 'NOT_FOUND ').toHttpStatus()).toBe(500);
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'returns 500 for the inherited object key %s',
    (code) => {
      expect(new ApprovalError('x', code).toHttpStatus()).toBe(500);
    },
  );
});

describe('README error-code table', () => {
  const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));
  const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  // The code is the last string argument of `new ApprovalError(message, 'CODE')`. errors.ts is
  // skipped: its subclass codes are documented by class, not by code.
  const CODE_ARG = /,\s*'([A-Z][A-Z_]+)',?\s*\)/g;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(dir, entry.name)]
          : [],
    );

  const codesInSource = new Set(
    sourceFiles(SRC_DIR)
      .filter((file) => basename(file) !== 'errors.ts')
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(CODE_ARG)].map((m) => m[1]!)),
  );

  it('finds the codes it is meant to guard', () => {
    expect(codesInSource).toContain('ALREADY_ACTED');
    expect(codesInSource).toContain('INCOMPLETE_CHAIN');
  });

  it.each([...codesInSource])('documents %s', (code) => {
    expect(README).toContain(`\`${code}\``);
  });
});
