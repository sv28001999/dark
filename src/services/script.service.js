import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import config from '../config/index.js';
import logger from '../config/logger.js';
import { RUN_STATUS } from '../constants/status.js';
import database from '../config/database.js';
import ApiError from '../utils/ApiError.js';
import * as notificationService from './notification.service.js';

const RUNS = 'runs'; // database collection

// Only the last part of a script's output is stored, so huge logs can't bloat the database.
const MAX_OUTPUT_CHARS = 10_000;

const STATUS_LABELS = {
  [RUN_STATUS.SUCCEEDED]: 'succeeded',
  [RUN_STATUS.FAILED]: 'failed',
  [RUN_STATUS.TIMED_OUT]: 'timed out',
  [RUN_STATUS.CANCELLED]: 'was cancelled',
};

/** Runs in progress in this process: runId -> { child, cancelled, finished } */
const activeRuns = new Map();

/** Names of runnable scripts: every .js file in the scripts directory not starting with "_". */
export async function listScripts() {
  let files;
  try {
    files = await readdir(config.scripts.dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return files
    .filter((file) => file.endsWith('.js') && !file.startsWith('_'))
    .map((file) => path.basename(file, '.js'))
    .sort();
}

async function resolveScriptPath(name) {
  // `name` is validated to letters, digits, "-" and "_", so it can't point outside the scripts directory.
  const scriptPath = path.join(config.scripts.dir, `${name}.js`);
  try {
    await access(scriptPath);
  } catch {
    throw ApiError.notFound(`Script "${name}" not found`);
  }
  return scriptPath;
}

export function getActiveRunCount() {
  return activeRuns.size;
}

/**
 * Starts a script in the background and returns the new run record immediately.
 * When the script finishes, its result is saved on the run and, if `notify` is set, a push is sent.
 */
export async function startRun(name, { args, notify }) {
  const scriptPath = await resolveScriptPath(name);

  if (activeRuns.size >= config.scripts.maxConcurrent) {
    throw new ApiError(429, `${activeRuns.size} scripts are already running, try again later`);
  }

  // Reserve the slot before any await so concurrent requests can't exceed the limit.
  const runId = database.newId(RUNS);
  const entry = { child: null, cancelled: false, finished: null };
  activeRuns.set(runId, entry);

  let run;
  try {
    run = await database.create(
      RUNS,
      { script: name, args, notify, status: RUN_STATUS.RUNNING, startedAt: new Date().toISOString() },
      runId,
    );
  } catch (err) {
    activeRuns.delete(runId);
    throw err;
  }

  entry.finished = execute(run, scriptPath, entry);
  return run;
}

/** Keeps the last MAX_OUTPUT_CHARS characters written to a stream. */
function collectTail(stream) {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    text = (text + chunk).slice(-MAX_OUTPUT_CHARS);
  });
  return () => text;
}

/** Runs the script as a separate Node.js process. The returned promise never rejects. */
function execute(run, scriptPath, entry) {
  const startedAt = Date.now();

  // No shell is involved: args are passed to the script as-is, so they can't inject commands.
  const child = spawn(process.execPath, [scriptPath, ...run.args], {
    env: { ...process.env, RUN_ID: run.id },
    windowsHide: true,
  });
  entry.child = child;
  logger.info({ runId: run.id }, `Script "${run.script}" started`);

  const stdout = collectTail(child.stdout);
  const stderr = collectTail(child.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, config.scripts.timeoutMs);

  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ exitCode: null, signal: null, error: err.message }));
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });

  return exited
    .then(async ({ exitCode, signal, error }) => {
      clearTimeout(timer);

      let status = RUN_STATUS.FAILED;
      if (timedOut) status = RUN_STATUS.TIMED_OUT;
      else if (entry.cancelled) status = RUN_STATUS.CANCELLED;
      else if (exitCode === 0) status = RUN_STATUS.SUCCEEDED;

      const result = {
        status,
        exitCode,
        signal,
        error,
        stdout: stdout(),
        stderr: stderr(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };

      logger.info(
        { runId: run.id, status, durationMs: result.durationMs },
        `Script "${run.script}" finished: ${status} (${result.durationMs}ms)`,
      );
      await database.update(RUNS, run.id, result);

      if (shouldNotify(run.notify, status)) {
        const notification = await notifyRunFinished({ ...run, ...result });
        await database.update(RUNS, run.id, {
          notification: { id: notification.id, status: notification.status },
        });
      }
    })
    .catch((err) => logger.error({ err, runId: run.id }, 'Failed to record script result'))
    .finally(() => activeRuns.delete(run.id));
}

function shouldNotify(notify, status) {
  if (!notify) return false;
  if (notify.when === 'success') return status === RUN_STATUS.SUCCEEDED;
  if (notify.when === 'failure') return status !== RUN_STATUS.SUCCEEDED;
  return true;
}

function lastLine(text) {
  return text.trim().split(/\r?\n/).at(-1)?.slice(0, 200);
}

function notifyRunFinished(run) {
  // `when` is a delivery rule, not part of the message, so it is left out of `target`.
  const { when, title, body, ...target } = run.notify;
  const output = run.status === RUN_STATUS.SUCCEEDED ? run.stdout : run.stderr || run.error || run.stdout;

  return notificationService.sendNotification(
    {
      ...target,
      title: title ?? `Script "${run.script}" ${STATUS_LABELS[run.status]}`,
      body: body ?? (lastLine(output) || `Finished in ${(run.durationMs / 1000).toFixed(1)}s`),
      data: { runId: run.id, script: run.script, status: run.status },
    },
    { source: `run:${run.id}` },
  );
}

export function listRuns({ limit }) {
  return database.list(RUNS, { limit });
}

export async function getRun(runId) {
  const run = await database.findById(RUNS, runId);
  if (!run) throw ApiError.notFound('Run not found');
  return run;
}

/** Stops a running script and returns the run once its cancellation has been recorded. */
export async function cancelRun(runId) {
  const entry = activeRuns.get(runId);

  if (!entry?.child) {
    const run = await getRun(runId);
    throw ApiError.conflict(`Run is not active (status: ${run.status})`);
  }

  entry.cancelled = true;
  entry.child.kill();
  await entry.finished;
  return getRun(runId);
}

/** Used on shutdown: stops every running script and waits until each result is recorded. */
export async function stopAllRuns() {
  const entries = [...activeRuns.values()];
  for (const entry of entries) {
    entry.cancelled = true;
    entry.child?.kill();
  }
  await Promise.all(entries.map((entry) => entry.finished));
}
