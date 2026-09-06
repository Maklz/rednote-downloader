import { spawn } from 'node:child_process';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// Telegram rejects bot uploads over 2GB and re-encodes anything it plays, so
// there is nothing to gain from 4K here. Falls back to a pre-muxed stream when
// ffmpeg is unavailable to merge separate video and audio.
const DEFAULT_FORMAT = 'bv*[height<=1080]+ba/b[height<=1080]/b';

export function buildYtDlpCommand(env = process.env) {
  const configured = String(env.YTDLP_COMMAND || '').trim();
  if (configured) {
    const parts = configured.split(/\s+/);
    return { command: parts[0], baseArgs: parts.slice(1) };
  }

  // Installed as a library rather than a standalone binary on most machines.
  return { command: env.PYTHON_COMMAND || 'python', baseArgs: ['-m', 'yt_dlp'] };
}

function buildCommonArgs(env = process.env) {
  const args = ['--no-warnings', '--no-playlist'];
  const ffmpegLocation = String(env.FFMPEG_LOCATION || '').trim();

  if (ffmpegLocation) {
    args.push('--ffmpeg-location', ffmpegLocation);
  }

  return args;
}

export function runYtDlp(args, options = {}) {
  const env = options.env || process.env;
  const { command, baseArgs } = buildYtDlpCommand(env);
  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...baseArgs, ...buildCommonArgs(env), ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to run yt-dlp (${command}): ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }

      // yt-dlp puts the useful part on the last stderr line.
      const detail = stderr.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`;
      reject(new Error(detail));
    });
  });
}

/**
 * Turns yt-dlp's metadata into the note shape the rest of the service speaks,
 * so a yt-dlp source travels the same path as a RedNote or X post.
 */
export function buildNoteFromYtDlpInfo(info, sourceUrl) {
  const width = Number(info?.width);
  const height = Number(info?.height);
  const duration = Number(info?.duration);

  return {
    noteId: info?.id ? `ytdlp:${info.extractor_key || 'unknown'}:${info.id}` : sourceUrl,
    title: info?.title || 'Video',
    description: '',
    type: 'video',
    resolvedUrl: info?.webpage_url || sourceUrl,
    uploadDate: normalizeUploadDate(info?.upload_date),
    author: {
      nickname: info?.uploader || info?.channel || '',
      userId: info?.uploader_id || info?.channel_id || '',
    },
    media: [{
      index: 1,
      type: 'video',
      // Nothing here is fetchable by URL: the streams are signed, and the best
      // ones need merging. The file is downloaded separately and uploaded from
      // disk, which is what localPath is for.
      url: '',
      localPath: '',
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      fallbackUrls: [],
    }],
  };
}

function normalizeUploadDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8}$/.test(raw)) {
    return null;
  }

  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

export async function probeVideo(sourceUrl, options = {}) {
  const output = await runYtDlp(['--dump-single-json', '--skip-download', sourceUrl], {
    ...options,
    timeoutMs: options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS,
  });

  let info;
  try {
    info = JSON.parse(output);
  } catch {
    throw new Error('yt-dlp returned output that is not JSON');
  }

  if (info?._type === 'playlist') {
    throw new Error('That link is a playlist or channel, not a single video');
  }

  return buildNoteFromYtDlpInfo(info, sourceUrl);
}

export async function downloadVideo(sourceUrl, targetDir, options = {}) {
  const env = options.env || process.env;
  const format = options.format || env.YTDLP_FORMAT || DEFAULT_FORMAT;
  const template = path.join(targetDir, '%(id)s.%(ext)s');

  await runYtDlp([
    '--format', format,
    '--merge-output-format', 'mp4',
    '--output', template,
    sourceUrl,
  ], {
    ...options,
    timeoutMs: options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS,
  });

  // The final extension depends on what was merged, so the directory is read
  // back rather than assumed. It is a fresh directory holding one download.
  const entries = await readdir(targetDir);
  const file = entries.find((name) => !name.endsWith('.part'));

  if (!file) {
    throw new Error('yt-dlp reported success but produced no file');
  }

  return path.join(targetDir, file);
}
