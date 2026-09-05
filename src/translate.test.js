import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTranslationConfigured, translateCaption } from './translate.js';

function stubClient(handler) {
  return { messages: { create: handler } };
}

const config = { enabled: true, apiKey: 'sk-test' };

test('isTranslationConfigured needs both the flag and a key', () => {
  assert.equal(isTranslationConfigured({ enabled: true, apiKey: 'k' }), true);
  assert.equal(isTranslationConfigured({ enabled: true, apiKey: '' }), false);
  assert.equal(isTranslationConfigured({ enabled: false, apiKey: 'k' }), false);
  assert.equal(isTranslationConfigured(undefined), false);
});

test('translateCaption returns the model text and the request it sent', async () => {
  let seen;
  const client = stubClient(async (params) => {
    seen = params;
    return { content: [{ type: 'text', text: 'Заголовок\n\nСсылка' }] };
  });

  const result = await translateCaption('标题\n\n链接', config, { client });

  assert.deepEqual(result, { text: 'Заголовок\n\nСсылка', translated: true });
  assert.equal(seen.model, 'claude-opus-5');
  assert.equal(seen.output_config.effort, 'low');
  assert.equal(seen.messages[0].content, '标题\n\n链接');
});

test('translateCaption keeps the original when translation is off', async () => {
  const client = stubClient(async () => {
    throw new Error('must not be called');
  });

  const result = await translateCaption('标题', { enabled: false, apiKey: 'k' }, { client });
  assert.deepEqual(result, { text: '标题', translated: false });
});

test('translateCaption falls back to the original when the API fails', async () => {
  const client = stubClient(async () => {
    throw new Error('rate limited');
  });

  const result = await translateCaption('标题', config, { client });

  assert.equal(result.text, '标题', 'the post still gets published');
  assert.equal(result.translated, false);
  assert.equal(result.error, 'rate limited');
});

test('translateCaption falls back on a refusal and on empty output', async () => {
  const refused = await translateCaption('标题', config, {
    client: stubClient(async () => ({ stop_reason: 'refusal', content: [] })),
  });
  assert.equal(refused.text, '标题');
  assert.match(refused.error, /refused/);

  const empty = await translateCaption('标题', config, {
    client: stubClient(async () => ({ content: [{ type: 'text', text: '   ' }] })),
  });
  assert.equal(empty.text, '标题');
  assert.match(empty.error, /empty/);
});

test('translateCaption skips blank input without calling the API', async () => {
  const client = stubClient(async () => {
    throw new Error('must not be called');
  });

  assert.deepEqual(await translateCaption('   ', config, { client }), { text: '', translated: false });
});
