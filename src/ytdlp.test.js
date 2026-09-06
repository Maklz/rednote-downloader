import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNoteFromYtDlpInfo, buildYtDlpCommand } from './ytdlp.js';

test('buildYtDlpCommand prefers an explicit command over the python module', () => {
  assert.deepEqual(buildYtDlpCommand({}), { command: 'python', baseArgs: ['-m', 'yt_dlp'] });
  assert.deepEqual(buildYtDlpCommand({ PYTHON_COMMAND: 'py' }), { command: 'py', baseArgs: ['-m', 'yt_dlp'] });
  assert.deepEqual(
    buildYtDlpCommand({ YTDLP_COMMAND: 'C:/tools/yt-dlp.exe' }),
    { command: 'C:/tools/yt-dlp.exe', baseArgs: [] },
  );
  // A configured command may carry its own arguments.
  assert.deepEqual(
    buildYtDlpCommand({ YTDLP_COMMAND: 'uv run yt-dlp' }),
    { command: 'uv', baseArgs: ['run', 'yt-dlp'] },
  );
});

test('buildNoteFromYtDlpInfo speaks the note shape the rest of the service uses', () => {
  const note = buildNoteFromYtDlpInfo({
    id: 'aqz-KE-bpKQ',
    extractor_key: 'Youtube',
    title: 'Big Buck Bunny',
    uploader: 'Blender',
    uploader_id: '@BlenderOfficial',
    webpage_url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    upload_date: '20141110',
    width: 3840,
    height: 2160,
    duration: 634.6,
  }, 'https://youtu.be/aqz-KE-bpKQ');

  assert.equal(note.title, 'Big Buck Bunny');
  assert.equal(note.author.nickname, 'Blender');
  assert.equal(note.uploadDate, '2014-11-10');
  // Namespaced so a YouTube id can never collide with a RedNote or X id in the
  // published history.
  assert.equal(note.noteId, 'ytdlp:Youtube:aqz-KE-bpKQ');

  const [media] = note.media;
  assert.equal(media.type, 'video');
  assert.equal(media.width, 3840);
  assert.equal(media.height, 2160);
  assert.equal(media.duration, 635);
  // Nothing is fetchable by URL here; the file arrives through localPath.
  assert.equal(media.url, '');
  assert.equal(media.localPath, '');
});

test('buildNoteFromYtDlpInfo copes with metadata that reports almost nothing', () => {
  const note = buildNoteFromYtDlpInfo({}, 'https://example.com/watch');

  assert.equal(note.noteId, 'https://example.com/watch', 'the URL keys the history when there is no id');
  assert.equal(note.title, 'Video');
  assert.equal(note.uploadDate, null);
  assert.equal(note.media[0].width, null);
  assert.equal(note.media[0].duration, null);

  // A malformed date is dropped rather than passed on.
  assert.equal(buildNoteFromYtDlpInfo({ upload_date: 'yesterday' }, 'u').uploadDate, null);
  assert.equal(buildNoteFromYtDlpInfo({ duration: -5 }, 'u').media[0].duration, null);
});
