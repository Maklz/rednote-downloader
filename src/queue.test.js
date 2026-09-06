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
