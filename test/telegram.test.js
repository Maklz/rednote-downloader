import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramBotRunner,
  buildPublishedNoteKey,
  buildBatchReport,
  buildPublishConfirmation,
  buildPublishedListText,
  parseCaptionCommand,
  parsePublishRequest,
  parseRepublishCommand,
  buildTelegramCaption,
  chunkTelegramMedia,
  getTelegramMediaGroupType,
  inferTelegramFileName,
  isTelegramChatAllowed,
} from '../src/telegram.js';

test('buildTelegramCaption includes title, author, description and URL', () => {
  const caption = buildTelegramCaption({
    title: '标题A',
    author: { nickname: '作者A' },
    description: '正文A',
    resolvedUrl: 'https://www.xiaohongshu.com/explore/demo',
  });

  assert.match(caption, /标题A/);
  assert.match(caption, /作者: 作者A/);
  assert.match(caption, /正文A/);
  assert.match(caption, /https:\/\/www\.xiaohongshu\.com\/explore\/demo/);
});

test('inferTelegramFileName generates numbered image file names', () => {
  const result = inferTelegramFileName(
    { type: 'image', url: 'https://ci.xiaohongshu.com/demo.jpg' },
    { title: '测试笔记' },
    1,
  );

  assert.equal(result, '测试笔记_02.jpg');
});

test('isTelegramChatAllowed accepts all chats when allowlist is empty', () => {
  assert.equal(isTelegramChatAllowed(12345, new Set()), true);
});

test('isTelegramChatAllowed enforces configured allowlist', () => {
  assert.equal(isTelegramChatAllowed(12345, new Set(['12345'])), true);
  assert.equal(isTelegramChatAllowed(67890, new Set(['12345'])), false);
});

test('chunkTelegramMedia splits into batches of ten', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }));
  const chunks = chunkTelegramMedia(items);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 10);
  assert.equal(chunks[1].length, 2);
  assert.equal(chunks[1][0].id, 11);
});

test('getTelegramMediaGroupType matches preview and document delivery modes', () => {
  assert.equal(getTelegramMediaGroupType({ type: 'image' }, 'preview'), 'photo');
  assert.equal(getTelegramMediaGroupType({ type: 'video' }, 'preview'), 'video');
  assert.equal(getTelegramMediaGroupType({ type: 'image' }, 'document'), 'document');
});

test('TelegramBotRunner persists update offset after handling a processed update', async () => {
  const originalFetch = global.fetch;
  const seenOffsets = [];
  const sendMessages = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target.includes('/getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                chat: { id: 12345 },
                text: '/help',
                message_id: 77,
              },
            },
          ],
        }),
      };
    }

    if (target.includes('/sendMessage')) {
      sendMessages.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      initialOffset: 0,
      onOffsetChange: async (offset) => {
        seenOffsets.push(offset);
      },
    });

    runner.running = true;
    await runner.pollOnce();

    assert.deepEqual(seenOffsets, [11]);
    assert.equal(runner.offset, 11);
    assert.equal(sendMessages.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramBotRunner does not acknowledge a later update when handling it fails', async () => {
  const originalFetch = global.fetch;
  const seenOffsets = [];
  let sendMessageCount = 0;

  global.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target.includes('/getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                chat: { id: 12345 },
                text: '/help',
                message_id: 77,
              },
            },
            {
              update_id: 11,
              message: {
                chat: { id: 12345 },
                text: '/help',
                message_id: 78,
              },
            },
          ],
        }),
      };
    }

    if (target.includes('/sendMessage')) {
      sendMessageCount += 1;
      if (sendMessageCount === 2) {
        throw new Error('temporary telegram send failure');
      }

      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      initialOffset: 0,
      onOffsetChange: async (offset) => {
        seenOffsets.push(offset);
      },
    });

    runner.running = true;
    await assert.rejects(
      runner.pollOnce(),
      /temporary telegram send failure/,
    );

    assert.deepEqual(seenOffsets, [11]);
    assert.equal(runner.offset, 11);
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramBotRunner drops an update that keeps failing so the queue can advance', async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const seenOffsets = [];
  let sendMessageCount = 0;

  global.fetch = async (url) => {
    const target = String(url);

    if (target.includes('/getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                chat: { id: 12345 },
                text: '/help',
                message_id: 77,
              },
            },
          ],
        }),
      };
    }

    if (target.includes('/sendMessage')) {
      sendMessageCount += 1;
      throw new Error('permanent telegram send failure');
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  console.error = () => {};

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      initialOffset: 0,
      onOffsetChange: async (offset) => {
        seenOffsets.push(offset);
      },
    });

    runner.running = true;

    await assert.rejects(runner.pollOnce(), /permanent telegram send failure/);
    assert.equal(runner.offset, 0);

    await assert.rejects(runner.pollOnce(), /permanent telegram send failure/);
    assert.equal(runner.offset, 0);

    // Third attempt gives up on the poison update and acknowledges it.
    await runner.pollOnce();

    assert.equal(sendMessageCount, 3);
    assert.deepEqual(seenOffsets, [11]);
    assert.equal(runner.offset, 11);
    assert.equal(runner.failedUpdateId, null);
    assert.equal(runner.failedUpdateAttempts, 0);
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('TelegramBotRunner uses fallback media URLs for Telegram uploads', async () => {
  const originalFetch = global.fetch;
  const seenTargets = [];
  let sendDocumentCount = 0;

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    seenTargets.push(target);

    if (target.includes('/sendChatAction')) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文',
            author: {
              id: 'user-1',
              name: 'Demo User',
              screen_name: 'demo',
            },
            media: {
              all: [
                {
                  type: 'video',
                  url: 'https://video.twimg.com/demo/original.mp4',
                  formats: [
                    {
                      url: 'https://video.twimg.com/demo/primary.mp4',
                      bitrate: 2000,
                      container: 'mp4',
                    },
                    {
                      url: 'https://video.twimg.com/demo/fallback.mp4',
                      bitrate: 1000,
                      container: 'mp4',
                    },
                  ],
                },
              ],
            },
          },
        }),
      };
    }

    if (target.includes('video.twimg.com/demo/primary.mp4')) {
      return new Response('missing', { status: 404 });
    }

    if (target.includes('video.twimg.com/demo/fallback.mp4')) {
      return new Response(
        new Uint8Array([1, 2, 3, 4]),
        {
          status: 200,
          headers: {
            'Content-Type': 'video/mp4',
          },
        },
      );
    }

    if (target.includes('/sendDocument')) {
      sendDocumentCount += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
    });

    await runner.handleMessage({
      chat: { id: 12345 },
      text: 'https://x.com/demo/status/1',
      message_id: 77,
    });

    assert.equal(sendDocumentCount, 1);
    assert.ok(seenTargets.some((target) => target.includes('video.twimg.com/demo/primary.mp4')));
    assert.ok(seenTargets.some((target) => target.includes('video.twimg.com/demo/fallback.mp4')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramBotRunner falls back to download links when Telegram rejects an upload as too large', async () => {
  const originalFetch = global.fetch;
  const sendMessages = [];
  let sendDocumentCount = 0;

  global.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    if (target.includes('api.fxtwitter.com/demo/status/2')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '2',
            url: 'https://x.com/demo/status/2',
            text: '示例推文',
            author: {
              id: 'user-1',
              name: 'Demo User',
              screen_name: 'demo',
            },
            media: {
              all: [
                {
                  type: 'video',
                  url: 'https://video.twimg.com/demo/large.mp4',
                  formats: [
                    {
                      url: 'https://video.twimg.com/demo/large.mp4',
                      bitrate: 2000,
                      container: 'mp4',
                    },
                  ],
                },
              ],
            },
          },
        }),
      };
    }

    if (target.includes('video.twimg.com/demo/large.mp4')) {
      return new Response(
        new Uint8Array([1, 2, 3, 4]),
        {
          status: 200,
          headers: {
            'Content-Type': 'video/mp4',
          },
        },
      );
    }

    if (target.includes('/sendDocument')) {
      sendDocumentCount += 1;
      return {
        ok: false,
        status: 413,
        json: async () => ({ ok: false, description: 'Request Entity Too Large' }),
      };
    }

    if (target.includes('/sendMessage')) {
      sendMessages.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
    });

    await runner.handleMessage({
      chat: { id: 12345 },
      text: 'https://x.com/demo/status/2',
      message_id: 88,
    });

    assert.equal(sendDocumentCount, 1);
    assert.equal(sendMessages.length, 1);
    assert.match(sendMessages[0].text, /这个文件太大，Telegram 不能直接回传/);
    assert.match(sendMessages[0].text, /https:\/\/video\.twimg\.com\/demo\/large\.mp4/);
    assert.doesNotMatch(sendMessages[0].text, /解析失败：/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramBotRunner stop aborts an in-flight long poll', async () => {
  const originalFetch = global.fetch;
  let aborted = false;

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.includes('/getUpdates')) {
      throw new Error(`Unexpected fetch: ${target}`);
    }

    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
    });

    const loopPromise = runner.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runner.stop();
    await loopPromise;

    assert.equal(aborted, true);
    assert.equal(runner.running, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildPublishedNoteKey prefers the note id over the URL', () => {
  assert.equal(buildPublishedNoteKey({ noteId: 'abc123', resolvedUrl: 'https://x/1' }, 'raw'), 'abc123');
  assert.equal(buildPublishedNoteKey({ resolvedUrl: 'https://x/1' }, 'raw'), 'https://x/1');
  assert.equal(buildPublishedNoteKey({}, 'raw'), 'raw');
});

// Drives one message through the bot and reports where media and text landed.
async function runBotWithMessage(options, text, extraNotes = {}) {
  const originalFetch = global.fetch;
  const sent = [];
  const savedNoteIds = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/getUpdates')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [{ update_id: 10, message: { chat: { id: 12345 }, text, message_id: 77 } }],
        }),
      };
    }

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      const body = JSON.parse(init.body);
      sent.push({ kind: 'text', chatId: String(body.chat_id), text: body.text });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendDocument') || target.includes('/sendMediaGroup')) {
      const chatId = init.body?.get ? String(init.body.get('chat_id')) : '?';
      sent.push({ kind: 'media', chatId });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      initialOffset: 0,
      onPublishedNoteIdsChange: async (ids) => { savedNoteIds.push([...ids]); },
      ...options,
    });

    // Stand in for the network-bound resolver.
    runner.resolveNoteImpl = null;
    runner.running = true;
    await runner.pollOnce();
    return { sent, savedNoteIds, runner };
  } finally {
    global.fetch = originalFetch;
  }
}

test('help text still replies to the sender even when a channel is configured', async () => {
  const { sent } = await runBotWithMessage({ targetChatId: '-1004376005872' }, '/help');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'text');
  assert.equal(sent[0].chatId, '12345');
});

test('rememberPublishedNote caps history and persists it', async () => {
  const saved = [];
  const runner = new TelegramBotRunner({
    token: 'demo-token',
    allowedChatIds: new Set(),
    initialPublishedNoteIds: ['old'],
    onPublishedNoteIdsChange: async (ids) => { saved.push([...ids]); },
  });

  await runner.rememberPublishedNote('first');
  await runner.rememberPublishedNote('first');
  await runner.rememberPublishedNote('second');

  assert.deepEqual(runner.publishedNoteIds, ['old', 'first', 'second']);
  assert.equal(saved.length, 2, 'a repeat must not be persisted twice');
  assert.deepEqual(saved.at(-1), ['old', 'first', 'second']);
});

test('parsePublishRequest splits the link from the caption at the first *', () => {
  const withCaption = parsePublishRequest('https://www.xiaohongshu.com/explore/x * Моя подпись');
  assert.equal(withCaption.linkText.trim(), 'https://www.xiaohongshu.com/explore/x');
  assert.equal(withCaption.caption, 'Моя подпись');

  const noCaption = parsePublishRequest('https://www.xiaohongshu.com/explore/x');
  assert.equal(noCaption.caption, '', 'no star means no caption at all');
  assert.equal(noCaption.linkText, 'https://www.xiaohongshu.com/explore/x');

  // A share blob keeps working: the URL is found before the star.
  const shareText = parsePublishRequest('看看这个 https://xhslink.com/abc 复制打开 * подпись');
  assert.match(shareText.linkText, /xhslink\.com\/abc/);
  assert.equal(shareText.caption, 'подпись');

  // Only the first star separates; later ones belong to the caption.
  assert.equal(parsePublishRequest('link * a * b').caption, 'a * b');

  // A star with nothing after it is still no caption.
  assert.equal(parsePublishRequest('link *   ').caption, '');
});

// Drives one message end to end and reports what reached Telegram's sendDocument.
async function publishToChannel(messageText) {
  const originalFetch = global.fetch;
  const documents = [];
  const messages = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: [{ type: 'video', url: 'https://video.twimg.com/demo/original.mp4' }] },
          },
        }),
      };
    }

    if (target.includes('video.twimg.com')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }

    if (target.includes('/sendDocument')) {
      documents.push({
        chatId: String(init.body.get('chat_id')),
        caption: init.body.get('caption'),
      });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      const body = JSON.parse(init.body);
      messages.push({ chatId: String(body.chat_id), text: body.text });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      targetChatId: '-1004376005872',
    });

    await runner.handleMessage({ chat: { id: 12345 }, text: messageText, message_id: 77 });
    return { documents, messages };
  } finally {
    global.fetch = originalFetch;
  }
}

test('a channel post carries the sender caption and none of the original text', async () => {
  const { documents, messages } = await publishToChannel('https://x.com/demo/status/1 * Мой текст');

  assert.equal(documents.length, 1);
  assert.equal(documents[0].chatId, '-1004376005872');
  assert.equal(documents[0].caption, 'Мой текст');

  // The confirmation goes to the sender, not the channel.
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, '12345');
});

test('a channel post without a * carries no caption at all', async () => {
  const { documents } = await publishToChannel('https://x.com/demo/status/1');

  assert.equal(documents.length, 1);
  assert.equal(documents[0].chatId, '-1004376005872');
  // Not the note title, not the author, not the URL — nothing.
  assert.equal(documents[0].caption, null);
});

test('replies to the sender still describe the note', async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/sendChatAction')) return { ok: true, json: async () => ({ ok: true, result: {} }) };
    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: [{ type: 'video', url: 'https://video.twimg.com/demo/original.mp4' }] },
          },
        }),
      };
    }
    if (target.includes('video.twimg.com')) {
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
    }
    if (target.includes('/sendDocument')) {
      captured = init.body.get('caption');
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    // No targetChatId: the old reply-to-sender behaviour is untouched.
    const runner = new TelegramBotRunner({ token: 'demo-token', allowedChatIds: new Set() });
    await runner.handleMessage({ chat: { id: 12345 }, text: 'https://x.com/demo/status/1', message_id: 77 });

    assert.match(captured, /示例推文正文/);
    assert.match(captured, /x\.com\/demo\/status\/1/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseRepublishCommand strips the prefix and only then', () => {
  assert.deepEqual(parseRepublishCommand('/again https://x/1 * текст'), {
    force: true,
    text: 'https://x/1 * текст',
  });
  assert.deepEqual(parseRepublishCommand('/repost https://x/1'), { force: true, text: 'https://x/1' });

  // Telegram appends @botname to commands sent in groups.
  assert.deepEqual(parseRepublishCommand('/again@mutantur_bot https://x/1'), {
    force: true,
    text: 'https://x/1',
  });

  // A plain link is untouched.
  assert.deepEqual(parseRepublishCommand('https://x/1 * текст'), {
    force: false,
    text: 'https://x/1 * текст',
  });

  // A word that merely starts with the command is not the command.
  assert.equal(parseRepublishCommand('/againstall https://x/1').force, false);

  // The command alone leaves nothing to resolve, which the caller reports.
  assert.deepEqual(parseRepublishCommand('/again'), { force: true, text: '' });
});

test('buildPublishConfirmation says which of the four things happened', () => {
  assert.equal(buildPublishConfirmation(false, ''), '已发布到频道。');
  assert.equal(buildPublishConfirmation(false, 'подпись'), '已发布到频道，带上了你的说明。');
  assert.equal(buildPublishConfirmation(true, ''), '已重新发布到频道。');
  assert.equal(buildPublishConfirmation(true, 'подпись'), '已重新发布到频道，带上了你的说明。');
});

test('/again publishes a note that is already in the history', async () => {
  const originalFetch = global.fetch;
  const documents = [];
  const messages = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: [{ type: 'video', url: 'https://video.twimg.com/demo/original.mp4' }] },
          },
        }),
      };
    }

    if (target.includes('video.twimg.com')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }

    if (target.includes('/sendDocument')) {
      documents.push({ chatId: String(init.body.get('chat_id')), caption: init.body.get('caption') });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      const body = JSON.parse(init.body);
      messages.push(body.text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'document',
      targetChatId: '-100999',
    });

    // First publish, no caption.
    await runner.handleMessage({ chat: { id: 1 }, text: 'https://x.com/demo/status/1', message_id: 1 });
    assert.equal(documents.length, 1);
    assert.equal(documents[0].caption, null);

    // Same link again: blocked, and the reply points at /again.
    await runner.handleMessage({ chat: { id: 1 }, text: 'https://x.com/demo/status/1', message_id: 2 });
    assert.equal(documents.length, 1, 'the duplicate must not reach the channel');
    assert.match(messages.at(-1), /\/again/);

    // With /again it goes out, this time with the caption.
    await runner.handleMessage({
      chat: { id: 1 },
      text: '/again https://x.com/demo/status/1 * Забытая подпись',
      message_id: 3,
    });
    assert.equal(documents.length, 2);
    assert.equal(documents[1].caption, 'Забытая подпись');
    assert.match(messages.at(-1), /已重新发布/);

    // The history still holds exactly one entry for the note.
    assert.equal(runner.publishedNoteIds.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildPublishedListText turns note ids back into links, newest first', () => {
  const text = buildPublishedListText([
    '6a818f8b000000002c002693',
    '6a9ad665000000001001ec1b',
  ]);

  assert.match(text, /已发布 2 条/);
  // Newest last in storage, so it must come out on top.
  const firstLine = text.split('\n').find((line) => line.startsWith('1. '));
  assert.equal(firstLine, '1. https://www.xiaohongshu.com/explore/6a9ad665000000001001ec1b');
});

test('buildPublishedListText handles an empty history, URL entries and the cap', () => {
  assert.equal(buildPublishedListText([]), '还没有发布过任何帖子。');

  // Entries that fell back to a URL are already links.
  assert.match(buildPublishedListText(['https://x.com/demo/status/1']), /https:\/\/x\.com\/demo\/status\/1/);

  const many = Array.from({ length: 25 }, (_, i) => `https://x.com/demo/status/${i}`);
  const capped = buildPublishedListText(many, 20);
  assert.match(capped, /已发布 25 条，最近 20 条/);
  assert.equal(capped.split('\n').filter((line) => /^\d+\. /.test(line)).length, 20);
  // The cap keeps the newest, not the oldest.
  assert.match(capped, /status\/24/);
  assert.ok(!capped.includes('status/4\n'), 'the oldest entries are dropped');
});

test('/list answers the sender without touching the channel', async () => {
  const originalFetch = global.fetch;
  const sent = [];

  global.fetch = async (url, init = {}) => {
    if (String(url).includes('/sendMessage')) {
      const body = JSON.parse(init.body);
      sent.push({ chatId: String(body.chat_id), text: body.text });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
      initialPublishedNoteIds: ['6a818f8b000000002c002693'],
    });

    await runner.handleMessage({ chat: { id: 12345 }, text: '/list', message_id: 1 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '12345');
    assert.match(sent[0].text, /xiaohongshu\.com\/explore\/6a818f8b000000002c002693/);
  } finally {
    global.fetch = originalFetch;
  }
});

// Publishes one note in preview mode and reports what Telegram was asked to do.
async function publishInPreviewMode(mediaAll, targetChatId = '-100999') {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: mediaAll },
          },
        }),
      };
    }

    if (target.includes('twimg.com')) {
      const isVideo = target.includes('.mp4');
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg' },
      });
    }

    if (target.includes('/sendVideo') || target.includes('/sendPhoto')) {
      calls.push({
        method: target.split('/').pop(),
        supportsStreaming: init.body.get('supports_streaming'),
      });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMediaGroup')) {
      calls.push({ method: 'sendMediaGroup', media: JSON.parse(init.body.get('media')) });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'preview',
      targetChatId,
    });

    await runner.handleMessage({ chat: { id: 1 }, text: 'https://x.com/demo/status/1', message_id: 1 });
    return calls;
  } finally {
    global.fetch = originalFetch;
  }
}

test('a single video is sent as a streamable video, not a file', async () => {
  const calls = await publishInPreviewMode([
    { type: 'video', url: 'https://video.twimg.com/demo/a.mp4' },
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendVideo');
  assert.equal(calls[0].supportsStreaming, 'true');
});

test('a video inside a media group is marked streamable too', async () => {
  // Albums are a direct-reply thing now: the channel posts each item on its own,
  // so this asks for the reply path by leaving the target chat empty.
  const calls = await publishInPreviewMode([
    { type: 'video', url: 'https://video.twimg.com/demo/a.mp4' },
    { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' },
  ], '');

  const group = calls.find((call) => call.method === 'sendMediaGroup');
  assert.ok(group, 'several items go out as one media group');

  const video = group.media.find((entry) => entry.type === 'video');
  assert.equal(video.supports_streaming, true);

  // Photos must not carry the flag.
  const photo = group.media.find((entry) => entry.type === 'photo');
  assert.equal(photo.supports_streaming, undefined);
});

// Publishes a note with several pictures and reports every Telegram call made.
async function publishGallery(targetChatId) {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: {
              all: [
                { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' },
                { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' },
                { type: 'photo', url: 'https://pbs.twimg.com/media/c.jpg' },
              ],
            },
          },
        }),
      };
    }

    if (target.includes('twimg.com')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }

    if (target.includes('/sendPhoto')) {
      calls.push({ method: 'sendPhoto', caption: init.body.get('caption') });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMediaGroup')) {
      calls.push({ method: 'sendMediaGroup', count: JSON.parse(init.body.get('media')).length });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'preview',
      targetChatId,
    });

    await runner.handleMessage({
      chat: { id: 1 },
      text: `https://x.com/demo/status/1${targetChatId ? ' * Подпись' : ''}`,
      message_id: 1,
    });
    return calls;
  } finally {
    global.fetch = originalFetch;
  }
}

test('every picture becomes its own channel post', async () => {
  const calls = await publishGallery('-100999');

  assert.equal(calls.length, 3, 'three pictures, three posts');
  assert.ok(calls.every((call) => call.method === 'sendPhoto'), 'no album is used');

  // The caption belongs on the first post only; repeating it three times
  // would just be noise.
  assert.equal(calls[0].caption, 'Подпись');
  assert.equal(calls[1].caption, null);
  assert.equal(calls[2].caption, null);
});

test('direct replies still group pictures into one album', async () => {
  const calls = await publishGallery('');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMediaGroup');
  assert.equal(calls[0].count, 3);
});

// Publishes a two-picture note to a channel, then hands back the runner and a
// log of every Telegram call, so a follow-up /undo can be inspected.
async function publishThenInspect() {
  const originalFetch = global.fetch;
  const calls = [];
  const savedRecords = [];
  let nextMessageId = 500;

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/1')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '1',
            url: 'https://x.com/demo/status/1',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: {
              all: [
                { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' },
                { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' },
              ],
            },
          },
        }),
      };
    }

    if (target.includes('twimg.com')) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }

    if (target.includes('/sendPhoto')) {
      nextMessageId += 1;
      calls.push({ method: 'sendPhoto', messageId: nextMessageId });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: nextMessageId } }) };
    }

    if (target.includes('/deleteMessage')) {
      const body = JSON.parse(init.body);
      calls.push({ method: 'deleteMessage', chatId: String(body.chat_id), messageId: body.message_id });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }

    if (target.includes('/sendMessage')) {
      const body = JSON.parse(init.body);
      calls.push({ method: 'sendMessage', text: body.text });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  const runner = new TelegramBotRunner({
    token: 'demo-token',
    allowedChatIds: new Set(),
    deliveryMode: 'preview',
    targetChatId: '-100999',
    onLastPublicationChange: async (record) => { savedRecords.push(record); },
  });

  await runner.handleMessage({ chat: { id: 1 }, text: 'https://x.com/demo/status/1', message_id: 1 });

  return { runner, calls, savedRecords, restore: () => { global.fetch = originalFetch; } };
}

test('/undo deletes the posted messages and frees the note', async () => {
  const { runner, calls, savedRecords, restore } = await publishThenInspect();

  try {
    const published = calls.filter((call) => call.method === 'sendPhoto');
    assert.equal(published.length, 2);
    assert.deepEqual(runner.lastPublication.messageIds, published.map((call) => call.messageId));
    assert.equal(runner.publishedNoteIds.length, 1);

    await runner.handleMessage({ chat: { id: 1 }, text: '/undo', message_id: 2 });

    const deletions = calls.filter((call) => call.method === 'deleteMessage');
    assert.equal(deletions.length, 2, 'both pictures are removed, not just the first');
    assert.ok(deletions.every((call) => call.chatId === '-100999'));

    // The note is released, so it can be published again.
    assert.equal(runner.publishedNoteIds.length, 0);
    assert.equal(runner.lastPublication, null);
    assert.equal(savedRecords.at(-1), null, 'the cleared record is persisted too');

    assert.match(calls.at(-1).text, /已从频道撤回 2 条消息/);
  } finally {
    restore();
  }
});

test('/undo says so when there is nothing to take back', async () => {
  const originalFetch = global.fetch;
  const sent = [];

  global.fetch = async (url, init = {}) => {
    if (String(url).includes('/sendMessage')) {
      sent.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
    });

    await runner.handleMessage({ chat: { id: 1 }, text: '/undo', message_id: 1 });
    assert.match(sent[0], /没有可撤回的发布/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('/undo reports a deletion Telegram refuses and keeps the record', async () => {
  const originalFetch = global.fetch;
  const sent = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/deleteMessage')) {
      throw new Error("message can't be deleted");
    }
    if (target.includes('/sendMessage')) {
      sent.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
      initialPublishedNoteIds: ['note-1'],
      initialLastPublication: { chatId: '-100999', noteId: 'note-1', messageIds: [501] },
    });

    await runner.handleMessage({ chat: { id: 1 }, text: '/undo', message_id: 1 });

    assert.match(sent[0], /撤回失败/);
    // Nothing was actually removed, so the history must not be rewritten.
    assert.deepEqual(runner.publishedNoteIds, ['note-1']);
    assert.ok(runner.lastPublication, 'the record survives so /undo can be retried');
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildBatchReport keeps the short answer for a single link', () => {
  const one = { published: ['a'], skipped: [], empty: [], failed: [] };
  assert.equal(buildBatchReport(one, false, ''), '已发布到频道。');
  assert.equal(buildBatchReport(one, false, 'подпись'), '已发布到频道，带上了你的说明。');
  assert.equal(buildBatchReport(one, true, ''), '已重新发布到频道。');
});

test('buildBatchReport accounts for every link once there are several', () => {
  const text = buildBatchReport({
    published: ['a', 'b'],
    skipped: ['c'],
    empty: ['d'],
    failed: [{ input: 'e', reason: 'Unsupported host: evil.example' }],
  }, false, '');

  assert.match(text, /已发布 2 条/);
  assert.match(text, /跳过 1 条/);
  assert.match(text, /1 条没有图片或视频/);
  assert.match(text, /失败：e — Unsupported host/);
});

test('a message with several links publishes all of them', async () => {
  const originalFetch = global.fetch;
  const posts = [];
  const replies = [];
  let messageId = 900;

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    const tweetMatch = target.match(/api\.fxtwitter\.com\/demo\/status\/(\d)/);
    if (tweetMatch) {
      const id = tweetMatch[1];
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id,
            url: `https://x.com/demo/status/${id}`,
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: [{ type: 'photo', url: `https://pbs.twimg.com/media/${id}.jpg` }] },
          },
        }),
      };
    }

    if (target.includes('twimg.com')) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }

    if (target.includes('/sendPhoto')) {
      messageId += 1;
      posts.push({ caption: init.body.get('caption'), messageId });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: messageId } }) };
    }

    if (target.includes('/sendMessage')) {
      replies.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'preview',
      targetChatId: '-100999',
    });

    await runner.handleMessage({
      chat: { id: 1 },
      text: 'https://x.com/demo/status/1 https://x.com/demo/status/2 https://x.com/demo/status/3 * Общая подпись',
      message_id: 1,
    });

    assert.equal(posts.length, 3, 'all three links reach the channel');
    // The caption lands on the first post only.
    assert.equal(posts[0].caption, 'Общая подпись');
    assert.equal(posts[1].caption, null);
    assert.equal(posts[2].caption, null);

    assert.match(replies.at(-1), /已发布 3 条/);

    // One record covers the whole message, so /undo takes all three back.
    assert.equal(runner.lastPublication.messageIds.length, 3);
    assert.equal(runner.lastPublication.noteIds.length, 3);
    assert.equal(runner.publishedNoteIds.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('one bad link does not stop the rest of the message', async () => {
  const originalFetch = global.fetch;
  const posts = [];
  const replies = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/sendChatAction')) {
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('api.fxtwitter.com/demo/status/2')) {
      return {
        ok: true,
        json: async () => ({
          code: 200,
          tweet: {
            id: '2',
            url: 'https://x.com/demo/status/2',
            text: '示例推文正文',
            author: { id: 'user-1', name: 'Demo User', screen_name: 'demo' },
            media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/2.jpg' }] },
          },
        }),
      };
    }

    if (target.includes('twimg.com')) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }

    if (target.includes('/sendPhoto')) {
      posts.push(init.body.get('caption'));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }

    if (target.includes('/sendMessage')) {
      replies.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      deliveryMode: 'preview',
      targetChatId: '-100999',
    });

    // The first host is not supported, so it fails before any network call.
    await runner.handleMessage({
      chat: { id: 1 },
      text: 'https://evil.example/post https://x.com/demo/status/2',
      message_id: 1,
    });

    assert.equal(posts.length, 1, 'the good link still goes out');
    assert.match(replies.at(-1), /已发布 1 条/);
    assert.match(replies.at(-1), /失败：https:\/\/evil\.example\/post/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseCaptionCommand recognises the command and leaves other text alone', () => {
  assert.deepEqual(parseCaptionCommand('/caption Новый текст'), { caption: 'Новый текст' });
  assert.deepEqual(parseCaptionCommand('/caption@mutantur_bot Новый текст'), { caption: 'Новый текст' });

  // No text clears the caption rather than being rejected.
  assert.deepEqual(parseCaptionCommand('/caption'), { caption: '' });
  assert.deepEqual(parseCaptionCommand('/caption   '), { caption: '' });

  // Not the command.
  assert.equal(parseCaptionCommand('/captionsomething text'), null);
  assert.equal(parseCaptionCommand('https://x.com/a * /caption'), null);
  assert.equal(parseCaptionCommand(''), null);
});

test('/caption rewrites the first message of the last publication', async () => {
  const originalFetch = global.fetch;
  const edits = [];
  const replies = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);

    if (target.includes('/editMessageCaption')) {
      edits.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    if (target.includes('/sendMessage')) {
      replies.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const runner = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
      // A gallery: only the first message carries a caption.
      initialLastPublication: { chatId: '-100999', noteIds: ['n1'], messageIds: [501, 502, 503] },
    });

    await runner.handleMessage({ chat: { id: 1 }, text: '/caption Исправленный текст', message_id: 1 });

    assert.equal(edits.length, 1, 'only the caption-carrying message is touched');
    assert.equal(edits[0].message_id, 501);
    assert.equal(edits[0].chat_id, '-100999');
    assert.equal(edits[0].caption, 'Исправленный текст');
    assert.match(replies.at(-1), /说明已更新/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('/caption reports having nothing to edit, and a refusal from Telegram', async () => {
  const originalFetch = global.fetch;
  const replies = [];

  global.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/editMessageCaption')) {
      throw new Error('message to edit not found');
    }
    if (target.includes('/sendMessage')) {
      replies.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const empty = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
    });
    await empty.handleMessage({ chat: { id: 1 }, text: '/caption текст', message_id: 1 });
    assert.match(replies.at(-1), /没有可以改说明的发布/);

    const stale = new TelegramBotRunner({
      token: 'demo-token',
      allowedChatIds: new Set(),
      targetChatId: '-100999',
      initialLastPublication: { chatId: '-100999', noteIds: ['n1'], messageIds: [501] },
    });
    await stale.handleMessage({ chat: { id: 1 }, text: '/caption текст', message_id: 2 });
    assert.match(replies.at(-1), /改说明失败：message to edit not found/);
  } finally {
    global.fetch = originalFetch;
  }
});
