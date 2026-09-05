import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramBotRunner,
  buildPublishedNoteKey,
  parsePublishRequest,
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
