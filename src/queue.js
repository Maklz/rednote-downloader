import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const QUEUE_STATUSES = ['pending', 'published', 'rejected'];
const MAX_HISTORY_ENTRIES = 200;

export function getQueuePath(env = process.env, configPath = '') {
  if (env.REVIEW_QUEUE_PATH) {
    return path.resolve(env.REVIEW_QUEUE_PATH);
  }

  // Next to the config and state files, so one data directory holds everything.
  return path.resolve(path.join(path.dirname(configPath), '.rednote-queue.json'));
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * One candidate awaiting a decision. The id is derived from the URL so the same
 * link offered twice updates its entry instead of stacking up duplicates.
 */
export function sanitizeQueueEntry(input = {}) {
  const url = normalizeString(input.url);
  if (!url) {
    return null;
  }

  const status = QUEUE_STATUSES.includes(input.status) ? input.status : 'pending';

  return {
    id: normalizeString(input.id) || buildEntryId(url),
    url,
    title: normalizeString(input.title) || 'Без названия',
    author: normalizeString(input.author),
    thumbnail: normalizeString(input.thumbnail),
    topic: normalizeString(input.topic),
    caption: normalizeString(input.caption),
    duration: normalizePositiveNumber(input.duration),
    width: normalizePositiveNumber(input.width),
    height: normalizePositiveNumber(input.height),
    sizeBytes: normalizePositiveNumber(input.sizeBytes),
    uploadDate: normalizeString(input.uploadDate),
    addedAt: normalizeString(input.addedAt) || new Date().toISOString(),
    decidedAt: normalizeString(input.decidedAt),
    error: normalizeString(input.error),
    status,
  };
}

export function buildEntryId(url) {
  // Short, stable and filename-safe; collisions between distinct URLs are not a
  // concern at the handful-per-hour rate this queue is filled at.
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = ((hash << 5) - hash + url.charCodeAt(index)) | 0;
  }

  return `c${Math.abs(hash).toString(36)}`;
}

export const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function sanitizeQueue(input) {
  const entries = Array.isArray(input?.entries) ? input.entries : [];
  const seen = new Map();

  for (const raw of entries) {
    const entry = sanitizeQueueEntry(raw);
    if (entry) {
      seen.set(entry.id, entry);
    }
  }

  return {
    entries: [...seen.values()],
    lastResetAt: normalizeTimestamp(input?.lastResetAt),
  };
}

function normalizeTimestamp(value) {
  const raw = normalizeString(value);
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : '';
}

export function isResetDue(queue, now = Date.now(), intervalMs = RESET_INTERVAL_MS) {
  const lastResetAt = sanitizeQueue(queue).lastResetAt;

  // A queue that has never been reset starts its cycle now rather than being
  // wiped the moment the server comes up.
  if (!lastResetAt) {
    return false;
  }

  return now - Date.parse(lastResetAt) >= intervalMs;
}

/**
 * Clears the candidates awaiting a decision so the next day's feed is built
 * from scratch. Decided entries stay: they are what stops a rejected video
 * from being offered again tomorrow.
 */
export function resetPendingEntries(queue, now = Date.now()) {
  const current = sanitizeQueue(queue);
  const kept = current.entries.filter((entry) => entry.status !== 'pending');

  return {
    queue: { entries: kept, lastResetAt: new Date(now).toISOString() },
    cleared: current.entries.length - kept.length,
  };
}

export async function loadQueue(queuePath) {
  try {
    return sanitizeQueue(JSON.parse(await readFile(queuePath, 'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { entries: [] };
    }

    throw error;
  }
}

export async function saveQueue(queuePath, queue) {
  const normalized = sanitizeQueue(queue);

  // Decided entries are history: keep the recent ones so the page can show what
  // happened, and drop the rest rather than letting the file grow forever.
  const pending = normalized.entries.filter((entry) => entry.status === 'pending');
  const decided = normalized.entries
    .filter((entry) => entry.status !== 'pending')
    .slice(-MAX_HISTORY_ENTRIES);

  const trimmed = {
    entries: [...pending, ...decided],
    // Stamped on first save so the daily cycle has a starting point.
    lastResetAt: normalized.lastResetAt || new Date().toISOString(),
  };

  await mkdir(path.dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
  return trimmed;
}

/**
 * Adds candidates, leaving alone any URL that has already been decided on --
 * re-offering something the reviewer rejected would just make them reject it
 * again.
 */
export function addQueueEntries(queue, candidates) {
  const current = sanitizeQueue(queue);
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  const added = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const entry = sanitizeQueueEntry({ ...candidate, status: 'pending' });
    if (!entry || byId.has(entry.id)) {
      continue;
    }

    byId.set(entry.id, entry);
    added.push(entry);
  }

  return { queue: { entries: [...byId.values()], lastResetAt: current.lastResetAt }, added };
}

export function updateQueueEntry(queue, id, patch) {
  const current = sanitizeQueue(queue);
  let updated = null;

  const entries = current.entries.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }

    updated = sanitizeQueueEntry({ ...entry, ...patch });
    return updated;
  });

  return { queue: { entries, lastResetAt: current.lastResetAt }, updated };
}

export function getPendingEntries(queue) {
  return sanitizeQueue(queue).entries.filter((entry) => entry.status === 'pending');
}
