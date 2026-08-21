#!/usr/bin/env node
/**
 * Examples smoke test.
 *
 * Runs every example's `index.mjs` under `examples/` as a child process and asserts it behaves
 * like a working demo: exits 0, prints something, and doesn't crash silently
 * into stderr. Examples are user-facing docs — this is the harness that keeps
 * them from rotting unnoticed (backlog item B12).
 *
 * Why a standalone script, not a vitest test:
 * `.github/workflows/ci.yml` runs `npm test` (vitest) BEFORE `npm run build`,
 * and `dist/` is git-ignored. A vitest-discovered test here would run before
 * `dist/` exists on every fresh CI checkout and fail permanently. This script
 * is never touched by vitest's default discovery (it isn't named `*.test.*`)
 * and is wired into CI as its own step placed AFTER the Build step.
 *
 * Local usage (build once, or whenever src/ changes):
 *   npm run build
 *   node scripts/examples-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLES_DIR = join(ROOT, 'examples');
const EXAMPLE_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 2_000;

// Content-based error signals for stderr. Some demos may legitimately write
// to stderr (a future one might), so presence alone is never the signal —
// only these known crash/warning patterns are.
const STDERR_ERROR_PATTERNS = [
  /UnhandledPromiseRejection/i,
  /unhandledRejection/i,
  /\bERR_[A-Z0-9_]+\b/,
  /^\s*(Type|Reference|Syntax|Range)?Error:/m,
  /Cannot find module/,
];

const PKG_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

/**
 * Recursively invokes `onFile` for every file under `dir`.
 * @param {string} dir Absolute directory path.
 * @param {(filePath: string) => void} onFile
 */
function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, onFile);
    } else {
      onFile(fullPath);
    }
  }
}

/**
 * Escapes regex metacharacters so a runtime string (e.g. the package name)
 * can be embedded safely in a `RegExp` constructor.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Discovers every runnable example. Deliberately glob-based, not a hardcoded
 * list — new examples (e.g. `examples/webhook-notifications/`) are picked up
 * automatically the moment they appear.
 * @returns {string[]} Absolute paths to each example's entry file.
 */
function discoverExamples() {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(EXAMPLES_DIR, entry.name, 'index.mjs'))
    .filter((entryFile) => existsSync(entryFile))
    .sort();
}

/**
 * True if the example imports the package by its bare name (e.g. the
 * `playground` example) rather than by a relative `../../dist/...` path.
 * Detected by scanning the source, not by hardcoding an example's name, so
 * any future example written the same way is covered automatically.
 * @param {string} examplePath
 * @returns {boolean}
 */
function needsPackageShim(examplePath) {
  const source = readFileSync(examplePath, 'utf8');
  const pattern = new RegExp(`from\\s+['"]${escapeRegExp(PKG_NAME)}(?:/[^'"]*)?['"]`);
  return pattern.test(source);
}

/**
 * Extracts the `dist/`-relative paths a set of examples import directly
 * (`from '../../dist/<path>'`), so the freshness guard checks exactly what's
 * actually used instead of a hardcoded file list.
 * @param {string[]} examplePaths
 * @returns {string[]}
 */
function collectDistImports(examplePaths) {
  const relImportPattern = /from\s+['"]\.\.\/\.\.\/dist\/([^'"]+)['"]/g;
  const distFiles = new Set();
  for (const examplePath of examplePaths) {
    const source = readFileSync(examplePath, 'utf8');
    for (const match of source.matchAll(relImportPattern)) {
      distFiles.add(match[1]);
    }
  }
  // Examples that only import the bare package name (e.g. playground) still
  // resolve through package.json `exports` to dist/index.js — always require
  // at least that file so the guard never runs against an empty checklist.
  if (distFiles.size === 0) {
    distFiles.add('index.js');
  }
  return [...distFiles];
}

/**
 * Fails loudly if `dist/` is missing or stale relative to `src/`, rather than
 * silently exercising an out-of-date build. Never auto-builds: this script's
 * job is to verify the shipped artifact, not to produce it.
 * @param {string[]} requiredDistFiles Paths relative to `dist/`.
 */
function assertDistFresh(requiredDistFiles) {
  const missing = requiredDistFiles.filter((file) => !existsSync(join(ROOT, 'dist', file)));
  if (missing.length > 0) {
    throw new Error(
      `dist/ is missing file(s) the examples import: ${missing.join(', ')}\n` +
        `  Run: npm run build`,
    );
  }

  let newestSrcMtime = 0;
  let newestSrcFile = null;
  walk(join(ROOT, 'src'), (filePath) => {
    if (!filePath.endsWith('.ts')) return;
    const mtime = statSync(filePath).mtimeMs;
    if (mtime > newestSrcMtime) {
      newestSrcMtime = mtime;
      newestSrcFile = filePath;
    }
  });

  const staleFiles = requiredDistFiles.filter(
    (file) => statSync(join(ROOT, 'dist', file)).mtimeMs < newestSrcMtime,
  );
  if (staleFiles.length > 0) {
    throw new Error(
      `dist/ looks stale — ${newestSrcFile?.replace(`${ROOT}/`, '')} was edited after ` +
        `dist/${staleFiles.join(', dist/')} was built.\n` +
        `  Run: npm run build`,
    );
  }
}

/**
 * Runs one example as a child process, capturing output and enforcing a hard
 * timeout so a hung demo fails the run instead of blocking it forever.
 * @param {string} examplePath
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runExample(examplePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [examplePath], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, EXAMPLE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Runs one example and reports pass/fail, surfacing the example's own
 * stdout/stderr on failure so a bare "exit code 1" never reaches whoever
 * digs into it next.
 * @param {string} examplePath
 * @returns {Promise<{ name: string, status: 'passed' | 'failed' }>}
 */
async function checkExample(examplePath) {
  const name = basename(dirname(examplePath));
  const { code, stdout, stderr, timedOut } = await runExample(examplePath);

  const problems = [];
  if (timedOut) problems.push(`timed out after ${EXAMPLE_TIMEOUT_MS}ms`);
  if (code !== 0) problems.push(`exited with code ${code}`);
  if (stdout.trim().length === 0) {
    problems.push('produced no stdout (a demo that prints nothing has likely broken silently)');
  }
  const stderrIsError = STDERR_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
  if (stderrIsError) problems.push('stderr contains an error signal');

  if (problems.length > 0) {
    console.error(
      `\n✖ ${name}: ${problems.join('; ')}\n` +
        `--- stdout ---\n${stdout || '(empty)'}\n` +
        `--- stderr ---\n${stderr || '(empty)'}\n`,
    );
    return { name, status: 'failed' };
  }

  console.log(`✓ ${name}`);
  return { name, status: 'passed' };
}

async function main() {
  console.log('hierarchical-approval — examples smoke test\n');

  const examples = discoverExamples();
  if (examples.length === 0) {
    console.error(`✖ No examples discovered under ${EXAMPLES_DIR}/*/index.mjs.`);
    process.exit(1);
  }

  try {
    assertDistFresh(collectDistImports(examples));
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }

  const shimPath = join(ROOT, 'node_modules', PKG_NAME);
  const shimPreexisting = existsSync(shimPath);
  const shimmedExamples = examples.filter(needsPackageShim);
  let shimError = null;

  if (shimmedExamples.length > 0 && !shimPreexisting) {
    try {
      // Self-referencing symlink so a bare `import 'hierarchical-approval'`
      // resolves the same way `npm link` would — lives in node_modules/ at
      // the repo root, never under examples/.
      symlinkSync(ROOT, shimPath, 'dir');
    } catch (err) {
      shimError = err;
    }
  }

  const results = [];
  try {
    for (const examplePath of examples) {
      const name = basename(dirname(examplePath));
      if (shimmedExamples.includes(examplePath) && shimError) {
        console.warn(
          `\n⚠ SKIPPED ${name}: imports the bare package name "${PKG_NAME}", which needs a ` +
            `node_modules resolution shim, and creating one failed: ${shimError.message}\n`,
        );
        results.push({ name, status: 'skipped' });
        continue;
      }
      results.push(await checkExample(examplePath));
    }
  } finally {
    if (shimmedExamples.length > 0 && !shimPreexisting && !shimError) {
      try {
        unlinkSync(shimPath);
      } catch {
        // Best-effort cleanup — a leftover shim only affects local dev, and
        // only for this one self-referencing package name.
      }
    }
  }

  const passed = results.filter((r) => r.status === 'passed');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(
    `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped ` +
      `(of ${results.length} discovered)\n`,
  );
  if (skipped.length > 0) {
    console.log(
      `Skipped: ${skipped.map((r) => r.name).join(', ')} — see warnings above for why.\n`,
    );
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
