import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';

import {
  addQueueEntries,
  buildEntryId,
  getPendingEntries,
  getQueuePath,
  isResetDue,
  resetPendingEntries,
  loadQueue,
  sanitizeQueueEntry,
  saveQueue,
  updateQueueEntry,
} from './queue.js';

test('sanitizeQueueEntry keeps what it can and drops what it cannot use', () => {
  const entry = sanitizeQueueEntry({
    url: ' https://youtu.be/abc ',
    title: '  Clip  ',
    duration: '61.4',
    width: 1280,
    height: '720',
    sizeBytes: 6829408,
    status: 'nonsense',
  });

  assert.equal(entry.url, 'https://youtu.be/abc');
  assert.equal(entry.title, 'Clip');
  assert.equal(entry.duration, 61);
  assert.equal(entry.height, 720);
  assert.equal(entry.status, 'pending', 'an unknown status falls back to pending');
  assert.match(entry.addedAt, /^\d{4}-\d{2}-\d{2}T/);

  // Without a URL there is nothing to publish, so there is no entry.
  assert.equal(sanitizeQueueEntry({ title: 'no url' }), null);
  assert.equal(sanitizeQueueEntry({}), null);

  // Nonsense numbers are dropped rather than shown as 0 or NaN.
  const bad = sanitizeQueueEntry({ url: 'u', duration: -3, width: 'wide', sizeBytes: 0 });
  assert.equal(bad.duration, null);
  assert.equal(bad.width, null);
  assert.equal(bad.sizeBytes, null);
});

test('buildEntryId is stable per URL and differs between URLs', () => {
  assert.equal(buildEntryId('https://youtu.be/abc'), buildEntryId('https://youtu.be/abc'));
  assert.notEqual(buildEntryId('https://youtu.be/abc'), buildEntryId('https://youtu.be/xyz'));
  assert.match(buildEntryId('https://youtu.be/abc'), /^c[0-9a-z]+$/);
});

test('addQueueEntries ignores anything already offered', () => {
  const first = addQueueEntries({ entries: [] }, [
    { url: 'https://youtu.be/a', title: 'A' },
    { url: 'https://youtu.be/b', title: 'B' },
  ]);
  assert.equal(first.added.length, 2);

  // The same link again adds nothing, even after a decision was made on it.
  const rejected = updateQueueEntry(first.queue, buildEntryId('https://youtu.be/a'), { status: 'rejected' });
  const second = addQueueEntries(rejected.queue, [
    { url: 'https://youtu.be/a', title: 'A again' },
    { url: 'https://youtu.be/c', title: 'C' },
  ]);

  assert.deepEqual(second.added.map((entry) => entry.url), ['https://youtu.be/c']);
  assert.equal(getPendingEntries(second.queue).length, 2, 'B and C await a decision');
});

test('a queue survives a round trip through disk and trims decided history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rednote-queue-'));
  const queuePath = path.join(dir, '.rednote-queue.json');

  try {
    assert.deepEqual(await loadQueue(queuePath), { entries: [] }, 'a missing file is an empty queue');

    const many = Array.from({ length: 260 }, (_, index) => ({
      url: `https://youtu.be/v${index}`,
      title: `V${index}`,
      status: 'published',
    }));
    const pending = [{ url: 'https://youtu.be/keep', title: 'Keep' }];

    const saved = await saveQueue(queuePath, { entries: [...many, ...pending] });

    assert.equal(saved.entries.filter((e) => e.status === 'pending').length, 1);
    assert.equal(saved.entries.filter((e) => e.status !== 'pending').length, 200, 'older history is dropped');

    const reloaded = await loadQueue(queuePath);
    assert.equal(reloaded.entries.length, saved.entries.length);
    assert.ok(reloaded.entries.some((e) => e.url === 'https://youtu.be/keep'));

    // Written as readable JSON, since a person may well open this file.
    assert.match(await readFile(queuePath, 'utf8'), /\n {2}"entries"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getQueuePath sits beside the config unless told otherwise', () => {
  const configPath = path.resolve(path.sep, 'data', 'config', '.rednote-config.json');
  assert.equal(
    getQueuePath({}, configPath),
    path.join(path.dirname(configPath), '.rednote-queue.json'),
  );

  const explicit = path.resolve(path.sep, 'tmp', 'queue.json');
  assert.equal(getQueuePath({ REVIEW_QUEUE_PATH: explicit }, configPath), explicit);
});

test('isResetDue waits a full day and never fires on a queue that never reset', () => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse('2026-09-06T10:00:00.000Z');

  // A fresh queue starts its cycle rather than being wiped on first sight.
  assert.equal(isResetDue({ entries: [] }, start), false);

  const queue = { entries: [], lastResetAt: new Date(start).toISOString() };
  assert.equal(isResetDue(queue, start + day - 1000), false, 'a minute short is not due');
  assert.equal(isResetDue(queue, start + day), true);
  assert.equal(isResetDue(queue, start + 3 * day), true, 'a long gap is still just due');

  // An unparseable stamp is treated as never-reset rather than as due.
  assert.equal(isResetDue({ entries: [], lastResetAt: 'вчера' }, start), false);
});

test('resetPendingEntries clears the feed but keeps what was decided', () => {
  const now = Date.parse('2026-09-07T10:00:00.000Z');
  const { queue, cleared } = resetPendingEntries({
    lastResetAt: '2026-09-06T10:00:00.000Z',
    entries: [
      { url: 'https://youtu.be/a', status: 'pending' },
      { url: 'https://youtu.be/b', status: 'pending' },
      { url: 'https://youtu.be/c', status: 'published' },
      { url: 'https://youtu.be/d', status: 'rejected' },
    ],
  }, now);

  assert.equal(cleared, 2);
  assert.equal(getPendingEntries(queue).length, 0, 'the feed is empty and rebuilds from scratch');

  // History survives: it is what stops a rejected video coming back tomorrow.
  assert.deepEqual(queue.entries.map((e) => e.url), ['https://youtu.be/c', 'https://youtu.be/d']);
  assert.equal(queue.lastResetAt, new Date(now).toISOString());
  assert.equal(isResetDue(queue, now), false, 'the cycle restarts from the reset');
});

test('a rejected video stays rejected across a reset', () => {
  const rejected = resetPendingEntries({
    lastResetAt: '2026-09-06T10:00:00.000Z',
    entries: [{ url: 'https://youtu.be/old', status: 'rejected' }],
  }).queue;

  const { added } = addQueueEntries(rejected, [{ url: 'https://youtu.be/old', title: 'Old' }]);
  assert.equal(added.length, 0, 'it is not offered again after the feed is cleared');
});
