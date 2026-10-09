// 假 media 模块：把 ffmpeg/ffprobe 调用重定向到 node test/fake-ffmpeg.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as real from '../server/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_FFMPEG = path.join(__dirname, 'fake-ffmpeg.mjs');

export const buildRecordArgs = real.buildRecordArgs;
export const buildRemuxArgs = real.buildRemuxArgs;
export const buildMergeArgs = real.buildMergeArgs;
export const buildConcatList = real.buildConcatList;
export const buildPlayArgs = real.buildPlayArgs;
export const extOfContainer = real.extOfContainer;
export const parseSegmentList = real.parseSegmentList;

export function spawnFfmpeg({ args = [], onStderr, onStdout } = {}) {
  return real.spawnFfmpeg({
    ffmpegPath: process.execPath,
    args: [FAKE_FFMPEG, ...args],
    onStderr,
    onStdout,
  });
}

export function runFfmpeg({ args = [], onStderr, onStdout } = {}) {
  return real.runFfmpeg({
    ffmpegPath: process.execPath,
    args: [FAKE_FFMPEG, ...args],
    onStderr,
    onStdout,
  });
}

export async function probeDuration() { return Number(process.env.FAKE_DURATION || 10); }
export async function probeJson(file) {
  return { durationSec: Number(process.env.FAKE_DURATION || 10), bytes: 1, width: 1920, height: 1080, hasVideo: true, vcodec: 'h264', acodec: 'aac' };
}
export async function ffmpegVersion() { return { available: true, version: 'ffmpeg version fake-7.0-livegrab' }; }
export { FAKE_FFMPEG as ffmpegPath };
export const probeDurationReal = real.probeDuration;
export const _file = fileURLToPath;
