import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_PUBLISHED_NOTE_IDS, normalizeEnvBoolean } from './config.js';
import { inferMediaFileName } from './shared/media-filenames.js';
import { extractAllUrls, extractFirstUrl, fetchMediaResponse, resolveNote } from './xhs.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_SECONDS = 30;
const MAX_CAPTION_LENGTH = 900;
const TELEGRAM_MEDIA_GROUP_LIMIT = 10;
const MAX_UPDATE_ATTEMPTS = 3;

export function parseAllowedChatIds(input) {
  return new Set(
    String(input || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function toTelegramApiUrl(token, method) {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

function trimCaption(text) {
  const source = String(text || '').trim();
  if (source.length <= MAX_CAPTION_LENGTH) {
    return source;
  }

  return `${source.slice(0, MAX_CAPTION_LENGTH - 1)}…`;
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

function isTelegramEntityTooLargeError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /request entity too large|entity too large|file is too big|payload too large|413/i.test(error.message);
}

export function buildTelegramCaption(note) {
  const lines = [
    note?.title || 'Untitled RedNote Note',
    note?.author?.nickname ? `作者: ${note.author.nickname}` : '',
    note?.description || '',
    note?.resolvedUrl || '',
  ].filter(Boolean);

  return trimCaption(lines.join('\n\n'));
}

const CAPTION_SEPARATOR = '*';

/**
 * Splits an incoming message at the first '*': everything before it is searched
 * for the post URL, everything after becomes the caption of the channel post.
 * Without a '*' there is no caption -- the channel gets the media on its own.
 */
export function parsePublishRequest(text) {
  const source = String(text || '');
  const separatorIndex = source.indexOf(CAPTION_SEPARATOR);

  if (separatorIndex < 0) {
    return { linkText: source, caption: '' };
  }

  return {
    linkText: source.slice(0, separatorIndex),
    caption: trimCaption(source.slice(separatorIndex + 1)),
  };
}

const REPUBLISH_COMMANDS = ['/again', '/repost'];

/**
 * Detects the "publish this again" prefix and strips it. Without it a post that
 * is already in the history is skipped, which is what stops a re-sent link from
 * being posted twice; with it the sender can deliberately post the same note
 * again, typically to give it the caption they forgot the first time.
 */
export function parseRepublishCommand(text) {
  const source = String(text || '');
  const trimmed = source.trimStart();

  for (const command of REPUBLISH_COMMANDS) {
    if (!trimmed.startsWith(command)) {
      continue;
    }

    // Telegram appends @botname to commands sent in groups.
    const rest = trimmed.slice(command.length).replace(/^@\S+/, '');
    if (rest && !/^\s/.test(rest)) {
      continue;
    }

    return { force: true, text: rest.trim() };
  }

  return { force: false, text: source };
}

const CAPTION_COMMAND = '/caption';

/**
 * Detects "/caption <text>", the way to fix the wording of the last channel
 * post without uploading its media again. Returns null when the message is not
 * that command, and an empty caption when the text is left out, which clears
 * the caption rather than rejecting the request.
 */
export function parseCaptionCommand(text) {
  const trimmed = String(text || '').trimStart();

  if (!trimmed.startsWith(CAPTION_COMMAND)) {
    return null;
  }

  // Telegram appends @botname to commands sent in groups.
  const rest = trimmed.slice(CAPTION_COMMAND.length).replace(/^@\S+/, '');
  if (rest && !/^\s/.test(rest)) {
    return null;
  }

  return { caption: trimCaption(rest) };
}

const XHS_NOTE_ID_PATTERN = /^[0-9a-f]{24}$/i;
// X post ids are long decimal numbers; /i/status/<id> resolves to the post
// whoever wrote it, so the author handle is not needed to link back.
const X_POST_ID_PATTERN = /^\d{2,25}$/;
const PUBLISHED_LIST_LIMIT = 20;

function buildPublishedEntryLink(entry) {
  if (XHS_NOTE_ID_PATTERN.test(entry)) {
    return `https://www.xiaohongshu.com/explore/${entry}`;
  }

  if (X_POST_ID_PATTERN.test(entry)) {
    return `https://x.com/i/status/${entry}`;
  }

  // Anything else is already a URL: the key falls back to one when the post
  // carried no id of its own.
  return entry;
}

/**
 * Renders the published history. Entries are stored as note ids, which are
 * meaningless on their own, so they are turned back into note URLs; entries
 * that fell back to a URL are already links and are shown as they are.
 */
export function buildPublishedListText(noteIds, limit = PUBLISHED_LIST_LIMIT) {
  const entries = Array.isArray(noteIds) ? noteIds : [];

  if (!entries.length) {
    return '还没有发布过任何帖子。';
  }

  // Newest first: the list is appended to as posts go out.
  const shown = entries.slice(-limit).reverse();
  const lines = shown.map((entry, index) => `${index + 1}. ${buildPublishedEntryLink(entry)}`);

  const header = entries.length > shown.length
    ? `已发布 ${entries.length} 条，最近 ${shown.length} 条：`
    : `已发布 ${entries.length} 条：`;

  return [header, '', ...lines].join('\n');
}

export function buildPublishConfirmation(force, caption) {
  const action = force ? '已重新发布到频道' : '已发布到频道';
  return caption ? `${action}，带上了你的说明。` : `${action}。`;
}

/**
 * Reports what one message produced. A single link keeps the short one-line
 * answer it always had; several links get a line per outcome, so nothing is
 * dropped without the sender being told.
 */
export function buildBatchReport(report, force, caption) {
  const total = report.published.length + report.skipped.length
    + report.empty.length + report.failed.length;

  if (total === 1 && report.published.length === 1) {
    return buildPublishConfirmation(force, caption);
  }

  const lines = [];

  if (report.published.length) {
    lines.push(force
      ? `已重新发布 ${report.published.length} 条。`
      : `已发布 ${report.published.length} 条。`);
  }

  if (report.skipped.length) {
    lines.push(`跳过 ${report.skipped.length} 条（已经发过，用 /again 可以再发）。`);
  }

  if (report.empty.length) {
    lines.push(`${report.empty.length} 条没有图片或视频，没发。`);
  }

  for (const failure of report.failed) {
    lines.push(`失败：${failure.input} — ${failure.reason}`);
  }

  return lines.length ? lines.join('\n') : '没有可发布的内容。';
}

export function inferTelegramFileName(item, note, index) {
  return inferMediaFileName(item, note, index, {
    totalItems: Array.isArray(note?.media) ? note.media.length : 1,
    fallbackBaseName: 'rednote',
  });
}

export function isTelegramChatAllowed(chatId, allowedChatIds) {
  if (!allowedChatIds?.size) {
    return true;
  }

  return allowedChatIds.has(String(chatId));
}

export function chunkTelegramMedia(items, chunkSize = TELEGRAM_MEDIA_GROUP_LIMIT) {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

export function getTelegramMediaGroupType(item, deliveryMode = 'document') {
  if (deliveryMode === 'preview') {
    return item?.type === 'video' ? 'video' : 'photo';
  }

  return 'document';
}

async function cleanupTempDirs(tempDirs) {
  await Promise.allSettled(
    tempDirs
      .filter(Boolean)
      .map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
}

function collectTelegramMediaCandidates(item) {
  return [...new Set([
    item?.url,
    ...(Array.isArray(item?.fallbackUrls) ? item.fallbackUrls : []),
  ].filter(Boolean))];
}

function buildTelegramOversizeFallbackText(item, note, index, caption) {
  const links = collectTelegramMediaCandidates(item);
  const fileName = inferTelegramFileName(item, note, index);
  const lines = [];

  if (caption) {
    lines.push(caption, '');
  }

  lines.push('这个文件太大，Telegram 不能直接回传。请直接下载：');
  lines.push(fileName);
  lines.push(...links);

  return lines.join('\n');
}

async function fetchTelegramUploadMedia(item) {
  const errors = [];

  for (const candidate of collectTelegramMediaCandidates(item)) {
    try {
      return await fetchMediaResponse(candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(errors[0] || 'Failed to download media for Telegram upload');
}

async function materializeTelegramUpload(item, note, index) {
  const { response } = await fetchTelegramUploadMedia(item);
  const contentType = response.headers.get('content-type') || (item.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const fileName = inferTelegramFileName(item, note, index);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rednote-telegram-'));
  const tempPath = path.join(tempDir, fileName);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));

  return {
    tempDir,
    fileBlob: await openAsBlob(tempPath, { type: contentType }),
    fileName,
  };
}

async function telegramRequest(token, method, payload, isMultipart = false) {
  const response = await fetch(toTelegramApiUrl(token, method), {
    method: 'POST',
    body: isMultipart ? payload : JSON.stringify(payload),
    headers: isMultipart ? undefined : { 'Content-Type': 'application/json' },
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data?.description || `Telegram API error (${response.status})`);
  }

  return data.result;
}

async function sendText(token, chatId, text, replyToMessageId) {
  return telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    disable_web_page_preview: true,
  });
}

async function deleteMessage(token, chatId, messageId) {
  return telegramRequest(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function editMessageCaption(token, chatId, messageId, caption) {
  return telegramRequest(token, 'editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
  });
}

async function sendChatAction(token, chatId, action) {
  return telegramRequest(token, 'sendChatAction', {
    chat_id: chatId,
    action,
  });
}

async function uploadMediaAsTelegramFile(token, method, fieldName, chatId, item, note, index, options = {}) {
  const upload = await materializeTelegramUpload(item, note, index);
  const body = new FormData();

  try {
    body.append('chat_id', String(chatId));
    if (options.replyToMessageId) {
      body.append('reply_to_message_id', String(options.replyToMessageId));
    }
    if (options.caption) {
      body.append('caption', options.caption);
    }

    // Without this Telegram serves the video as a plain download rather than
    // something the viewer can start playing before it has finished arriving.
    if (fieldName === 'video') {
      body.append('supports_streaming', 'true');
    }

    body.append(fieldName, upload.fileBlob, upload.fileName);

    return await telegramRequest(token, method, body, true);
  } finally {
    await cleanupTempDirs([upload.tempDir]);
  }
}

async function uploadMediaGroup(token, chatId, note, items, startIndex, options = {}) {
  const deliveryMode = options.deliveryMode || 'document';
  const body = new FormData();
  const mediaEntries = [];
  const tempDirs = [];

  try {
    body.append('chat_id', String(chatId));
    if (options.replyToMessageId) {
      body.append('reply_to_message_id', String(options.replyToMessageId));
    }

    for (const [offset, item] of items.entries()) {
      const itemIndex = startIndex + offset;
      const fieldName = `media_${itemIndex}`;
      const upload = await materializeTelegramUpload(item, note, itemIndex);

      tempDirs.push(upload.tempDir);
      body.append(fieldName, upload.fileBlob, upload.fileName);

      const mediaEntry = {
        type: getTelegramMediaGroupType(item, deliveryMode),
        media: `attach://${fieldName}`,
      };

      if (mediaEntry.type === 'video') {
        mediaEntry.supports_streaming = true;
      }

      if (offset === 0 && options.caption) {
        mediaEntry.caption = options.caption;
      }

      mediaEntries.push(mediaEntry);
    }

    body.append('media', JSON.stringify(mediaEntries));
    return await telegramRequest(token, 'sendMediaGroup', body, true);
  } finally {
    await cleanupTempDirs(tempDirs);
  }
}

async function sendTelegramOversizeFallback(token, chatId, item, note, index, options = {}) {
  const text = buildTelegramOversizeFallbackText(item, note, index, options.caption);
  return sendText(token, chatId, text, options.replyToMessageId);
}

// Telegram answers with a Message for a single send and an array of them for a
// media group, so both shapes are flattened to the ids the caller cares about.
function collectMessageIds(result) {
  const messages = Array.isArray(result) ? result : [result];
  return messages
    .map((entry) => entry?.message_id)
    .filter((id) => Number.isInteger(id));
}

async function sendResolvedMediaItem(token, chatId, item, note, index, options = {}) {
  const deliveryMode = options.deliveryMode || 'document';

  try {
    if (deliveryMode === 'preview') {
      const method = item.type === 'video' ? 'sendVideo' : 'sendPhoto';
      const fieldName = item.type === 'video' ? 'video' : 'photo';
      return collectMessageIds(
        await uploadMediaAsTelegramFile(token, method, fieldName, chatId, item, note, index, {
          replyToMessageId: options.replyToMessageId,
          caption: options.caption,
        }),
      );
    }

    return collectMessageIds(
      await uploadMediaAsTelegramFile(token, 'sendDocument', 'document', chatId, item, note, index, {
        replyToMessageId: options.replyToMessageId,
        caption: options.caption,
      }),
    );
  } catch (error) {
    if (!isTelegramEntityTooLargeError(error)) {
      throw error;
    }

    console.warn('[telegram] media upload exceeded Telegram size limit, sending fallback links:', error.message);
    return collectMessageIds(await sendTelegramOversizeFallback(token, chatId, item, note, index, options));
  }
}

async function sendResolvedMediaSequential(token, chatId, note, options = {}) {
  const deliveryMode = options.deliveryMode || 'document';
  const caption = options.caption === undefined ? buildTelegramCaption(note) : options.caption;

  const messageIds = [];

  for (const [index, item] of note.media.entries()) {
    messageIds.push(...await sendResolvedMediaItem(token, chatId, item, note, index, {
      deliveryMode,
      replyToMessageId: index === 0 ? options.replyToMessageId : undefined,
      caption: index === 0 ? caption : undefined,
    }));
  }

  return messageIds;
}

async function sendResolvedMedia(token, chatId, note, options = {}) {
  const media = Array.isArray(note?.media) ? note.media : [];
  const caption = options.caption === undefined ? buildTelegramCaption(note) : options.caption;

  if (!media.length) {
    return collectMessageIds(await sendText(token, chatId, caption, options.replyToMessageId));
  }

  if (media.length === 1) {
    const [item] = media;
    return sendResolvedMediaItem(token, chatId, item, note, 0, {
      deliveryMode: options.deliveryMode,
      replyToMessageId: options.replyToMessageId,
      caption,
    });
  }

  // A channel wants one post per picture, not a single album the reader has to
  // open to page through. Direct replies keep grouping, which is tidier in a
  // one-to-one chat.
  if (options.separateItems) {
    return sendResolvedMediaSequential(token, chatId, note, { ...options, caption });
  }

  try {
    const chunks = chunkTelegramMedia(media);
    const messageIds = [];

    for (const [chunkIndex, chunk] of chunks.entries()) {
      messageIds.push(...collectMessageIds(
        await uploadMediaGroup(token, chatId, note, chunk, chunkIndex * TELEGRAM_MEDIA_GROUP_LIMIT, {
          deliveryMode: options.deliveryMode,
          replyToMessageId: chunkIndex === 0 ? options.replyToMessageId : undefined,
          caption: chunkIndex === 0 ? caption : undefined,
        }),
      ));
    }

    return messageIds;
  } catch (error) {
    console.warn('[telegram] media group send failed, falling back to sequential uploads:', error instanceof Error ? error.message : error);
    return sendResolvedMediaSequential(token, chatId, note, { ...options, caption });
  }
}

function buildHelpText() {
  return [
    '把小红书链接、x.com/twitter.com 链接，或整段分享文案直接发给我。',
    '我会解析帖子并把图片/视频直接回到 Telegram。',
    '',
    '发布到频道时只发图片和视频，不带原帖标题、正文和链接。',
    '想给频道里的帖子写说明，就在链接后面加一个 * 再写你的文字：',
    'https://www.xiaohongshu.com/... * 这里是你的说明',
    '',
    '同一条帖子默认只发一次。想再发一次（比如补上说明），在前面加 /again：',
    '/again https://www.xiaohongshu.com/... * 补上的说明',
    '',
    '一条消息里可以放多个链接，会逐条发布，说明放在第一条上。',
    '',
    '/list 可以看已经发布过哪些帖子。',
    '/undo 撤回上一次发布，频道里的消息会被删掉，那条帖子也能重新发。',
    '/caption 新的说明 直接改上一次发布的说明，不用重新上传。',
    '',
    '如果你想保留原始文件质量，保持默认 document 模式就可以。',
  ].join('\n');
}

// Prefers the note id so the same post sent as a short link and as a full page
// URL counts as one; falls back to the resolved URL, then the raw input.
export function buildPublishedNoteKey(note, input) {
  const noteId = String(note?.noteId || '').trim();
  if (noteId) {
    return noteId;
  }

  return String(note?.resolvedUrl || input || '').trim();
}

export class TelegramBotRunner {
  constructor(options) {
    this.token = options.token;
    this.allowedChatIds = options.allowedChatIds;
    this.deliveryMode = options.deliveryMode || 'document';
    this.offset = Number.isInteger(options.initialOffset) && options.initialOffset >= 0
      ? options.initialOffset
      : 0;
    this.onOffsetChange = typeof options.onOffsetChange === 'function'
      ? options.onOffsetChange
      : null;
    this.targetChatId = String(options.targetChatId || '').trim();
    this.publishedNoteIds = Array.isArray(options.initialPublishedNoteIds)
      ? [...options.initialPublishedNoteIds]
      : [];
    this.onPublishedNoteIdsChange = typeof options.onPublishedNoteIdsChange === 'function'
      ? options.onPublishedNoteIdsChange
      : null;
    this.lastPublication = options.initialLastPublication || null;
    this.onLastPublicationChange = typeof options.onLastPublicationChange === 'function'
      ? options.onLastPublicationChange
      : null;
    this.running = false;
    this.loopPromise = null;
    this.pollController = null;
    this.failedUpdateId = null;
    this.failedUpdateAttempts = 0;
  }

  async fetchUpdates() {
    const url = new URL(toTelegramApiUrl(this.token, 'getUpdates'));
    url.searchParams.set('timeout', String(POLL_TIMEOUT_SECONDS));
    url.searchParams.set('offset', String(this.offset));

    const controller = new AbortController();
    this.pollController = controller;

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data?.description || `Telegram polling failed (${response.status})`);
      }

      return data.result || [];
    } finally {
      if (this.pollController === controller) {
        this.pollController = null;
      }
    }
  }

  async handleMessage(message) {
    const chatId = message?.chat?.id;
    if (!chatId) {
      return;
    }

    if (!isTelegramChatAllowed(chatId, this.allowedChatIds)) {
      await sendText(this.token, chatId, 'This bot is not enabled for this Telegram chat.', message.message_id);
      return;
    }

    const text = message?.text || message?.caption || '';
    if (!text) {
      return;
    }

    if (text === '/start' || text === '/help') {
      await sendText(this.token, chatId, buildHelpText(), message.message_id);
      return;
    }

    if (text === '/list') {
      await sendText(this.token, chatId, buildPublishedListText(this.publishedNoteIds), message.message_id);
      return;
    }

    if (text === '/undo') {
      await sendText(this.token, chatId, await this.undoLastPublication(), message.message_id);
      return;
    }

    const captionEdit = parseCaptionCommand(text);
    if (captionEdit) {
      await sendText(this.token, chatId, await this.editLastCaption(captionEdit.caption), message.message_id);
      return;
    }

    const { force, text: requestText } = parseRepublishCommand(text);
    const { linkText, caption } = parsePublishRequest(requestText);

    let inputs;
    try {
      // Every link in the message, not just the first: sending three used to
      // publish one and drop the rest without saying anything.
      inputs = this.targetChatId ? extractAllUrls(linkText) : [extractFirstUrl(linkText)];
    } catch {
      await sendText(this.token, chatId, '请直接发送小红书链接、x.com/twitter.com 链接，或者包含这些链接的整段分享文案。', message.message_id);
      return;
    }

    try {
      await sendChatAction(this.token, chatId, 'upload_document');

      if (!this.targetChatId) {
        const note = await resolveNote(inputs[0]);
        await sendResolvedMedia(this.token, chatId, note, {
          deliveryMode: this.deliveryMode,
          replyToMessageId: message.message_id,
        });
        return;
      }

      const report = await this.publishToChannel(inputs, { caption, force });
      await sendText(this.token, chatId, buildBatchReport(report, force, caption), message.message_id);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Unknown error';
      await sendText(this.token, chatId, `解析失败：${messageText}`, message.message_id);
    }
  }

  /**
   * Publishes every link from one message. The caption goes on the first post
   * that actually goes out, the same rule that puts it on the first picture of
   * a gallery. One publication record covers the whole message, so /undo takes
   * back everything that message produced, not only its last link.
   */
  async publishToChannel(inputs, { caption, force }) {
    const report = {
      published: [], skipped: [], empty: [], failed: [],
    };
    const messageIds = [];
    const noteIds = [];
    let captionUsed = false;

    for (const input of inputs) {
      try {
        const note = await resolveNote(input);
        const noteKey = buildPublishedNoteKey(note, input);

        if (!force && this.publishedNoteIds.includes(noteKey)) {
          report.skipped.push(input);
          continue;
        }

        // Nothing but media goes to the channel, so a post without any has
        // nothing to publish.
        if (!note?.media?.length) {
          report.empty.push(input);
          continue;
        }

        // Published first, remembered second: a crash in between repeats a
        // post, which is recoverable, while the reverse silently loses it.
        // caption is passed explicitly, '' included: the channel gets the
        // sender's own words or nothing, never the original title and link.
        const sent = await sendResolvedMedia(this.token, this.targetChatId, note, {
          deliveryMode: this.deliveryMode,
          caption: captionUsed ? '' : caption,
          separateItems: true,
        });

        captionUsed = captionUsed || Boolean(caption);
        messageIds.push(...sent);
        noteIds.push(noteKey);
        report.published.push(input);
        await this.rememberPublishedNote(noteKey);
      } catch (error) {
        report.failed.push({
          input,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (messageIds.length) {
      await this.rememberLastPublication({
        chatId: String(this.targetChatId),
        noteIds,
        messageIds,
      });
    }

    return report;
  }

  /**
   * Rewrites the caption of the last publication in place. Only the first
   * message of a publication carries one -- the rest of a gallery is bare -- so
   * that is the one edited, and the media is left alone rather than re-uploaded.
   */
  async editLastCaption(caption) {
    const record = this.lastPublication;

    if (!record?.messageIds?.length) {
      return '没有可以改说明的发布。';
    }

    try {
      await editMessageCaption(this.token, record.chatId, record.messageIds[0], caption);
    } catch (error) {
      return `改说明失败：${error instanceof Error ? error.message : error}`;
    }

    return caption ? '说明已更新。' : '说明已清空。';
  }

  async rememberLastPublication(record) {
    this.lastPublication = record;

    if (this.onLastPublicationChange) {
      await this.onLastPublicationChange(record);
    }
  }

  /**
   * Takes back the most recent channel post: deletes its messages and releases
   * the note from the published history so it can go out again. Telegram only
   * lets a bot delete its own messages for 48 hours, so an older post reports
   * what could not be removed instead of pretending it worked.
   */
  async undoLastPublication() {
    const record = this.lastPublication;

    if (!record?.messageIds?.length) {
      return '没有可撤回的发布。';
    }

    const failures = [];

    for (const messageId of record.messageIds) {
      try {
        await deleteMessage(this.token, record.chatId, messageId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length === record.messageIds.length) {
      return `撤回失败：${failures[0]}`;
    }

    const releasedNoteIds = new Set(Array.isArray(record.noteIds) ? record.noteIds : []);
    if (releasedNoteIds.size) {
      this.publishedNoteIds = this.publishedNoteIds.filter((id) => !releasedNoteIds.has(id));
      if (this.onPublishedNoteIdsChange) {
        await this.onPublishedNoteIdsChange(this.publishedNoteIds);
      }
    }

    await this.rememberLastPublication(null);

    if (failures.length) {
      return `已撤回 ${record.messageIds.length - failures.length}/${record.messageIds.length} 条，其余删不掉：${failures[0]}`;
    }

    return `已从频道撤回 ${record.messageIds.length} 条消息，这条帖子可以重新发布了。`;
  }

  async rememberPublishedNote(noteKey) {
    if (!noteKey || this.publishedNoteIds.includes(noteKey)) {
      return;
    }

    this.publishedNoteIds = [...this.publishedNoteIds, noteKey].slice(-MAX_PUBLISHED_NOTE_IDS);

    if (this.onPublishedNoteIdsChange) {
      await this.onPublishedNoteIdsChange(this.publishedNoteIds);
    }
  }

  async pollOnce() {
    const updates = await this.fetchUpdates();

    for (const update of updates) {
      if (!this.running) {
        return;
      }

      const updateId = update.update_id || 0;

      try {
        if (update.message) {
          await this.handleMessage(update.message);
        }

        this.failedUpdateId = null;
        this.failedUpdateAttempts = 0;
      } catch (error) {
        this.failedUpdateAttempts = this.failedUpdateId === updateId ? this.failedUpdateAttempts + 1 : 1;
        this.failedUpdateId = updateId;

        if (this.failedUpdateAttempts < MAX_UPDATE_ATTEMPTS) {
          // Leave the offset untouched so Telegram redelivers this update on the next poll.
          throw error;
        }

        console.error(
          `[telegram] dropping update ${updateId} after ${this.failedUpdateAttempts} failed attempts:`,
          error instanceof Error ? error.message : error,
        );
        this.failedUpdateId = null;
        this.failedUpdateAttempts = 0;
      }

      const nextOffset = Math.max(this.offset, updateId + 1);
      if (nextOffset !== this.offset) {
        this.offset = nextOffset;
        if (this.onOffsetChange) {
          await this.onOffsetChange(this.offset);
        }
      }
    }
  }

  start() {
    if (this.loopPromise) {
      return this.loopPromise;
    }

    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (!this.running && isAbortError(error)) {
            break;
          }

          console.error('[telegram] polling error:', error instanceof Error ? error.message : error);
          if (!this.running) {
            break;
          }
          await delay(3000);
        }
      }
    })().finally(() => {
      this.running = false;
      this.loopPromise = null;
    });

    return this.loopPromise;
  }

  async stop() {
    this.running = false;
    if (this.pollController) {
      this.pollController.abort();
    }

    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
    }
  }
}

export function getTelegramConfigFromEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!token || !normalizeEnvBoolean(process.env.TELEGRAM_ENABLED, true)) {
    return null;
  }

  return {
    token,
    allowedChatIds: parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    deliveryMode: process.env.TELEGRAM_DELIVERY_MODE === 'preview' ? 'preview' : 'document',
  };
}
