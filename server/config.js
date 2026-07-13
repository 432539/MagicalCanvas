/**
 * config.js
 *
 * Runtime configuration store for API keys and related settings.
 *
 * Keys are read dynamically from a writable JSON config file so that the
 * in-app Settings page can update them without restarting the server.
 * Resolution order for any key: config.json value > process.env value > ''.
 *
 * When packaged as a desktop app (Electron), the main process sets
 * CONFIG_DIR to a writable user-data location.
 */

import fs from 'fs';
import path from 'path';

// Directory that holds the writable config file.
const CONFIG_DIR = process.env.CONFIG_DIR || process.cwd();
const CONFIG_PATH = path.join(CONFIG_DIR, 'twitcanva-config.json');

// All settings keys the app understands.
// 三类模型，每类独立配置：网址(URL) / 密钥(KEY) / 模型名(MODEL)
export const SETTINGS_KEYS = [
    // 文字模型
    'TEXT_API_URL',
    'TEXT_API_KEY',
    'TEXT_MODEL',
    // 图片模型
    'IMAGE_API_URL',
    'IMAGE_API_KEY',
    'IMAGE_MODEL',
    // 视频模型
    'VIDEO_API_URL',
    'VIDEO_API_KEY',
    'VIDEO_MODEL',
    // 语音识别（智能字幕，OpenAI 兼容 /audio/transcriptions 接口）
    'ASR_API_URL',
    'ASR_API_KEY',
    'ASR_MODEL',
    // 生成并发数（批量生成/一键创作时同时进行的生成任务数）
    'GEN_CONCURRENCY',
];

// 默认值（当配置文件与环境变量都未设置时使用）
export const DEFAULTS = {
    TEXT_API_URL: 'https://www.gpt2api.com/v1',
    TEXT_MODEL: 'grok-4.20-fast',
    IMAGE_API_URL: 'https://www.gpt2api.com/v1',
    IMAGE_MODEL: 'nano-banana-pro',
    VIDEO_API_URL: 'https://www.gpt2api.com/v1',
    VIDEO_MODEL: 'xai/grok-imagine-video',
    ASR_MODEL: 'whisper-1',
    GEN_CONCURRENCY: '3',
};

/**
 * Reads and parses the config file. Returns an empty object on any error.
 * @returns {Record<string, string>}
 */
export function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (err) {
        console.warn('[Config] Failed to read config file:', err.message);
    }
    return {};
}

/**
 * Resolves a single key: config file value first, then environment variable.
 * @param {string} name
 * @returns {string}
 */
export function getKey(name) {
    const cfg = loadConfig();
    const fromFile = cfg[name];
    if (fromFile !== undefined && fromFile !== null && fromFile !== '') return String(fromFile);
    if (process.env[name]) return process.env[name];
    return DEFAULTS[name] || '';
}

/**
 * Merges and persists the provided settings into the config file.
 * Only known keys are written. Empty strings are stored as-is (clears a key).
 * @param {Record<string, string>} updates
 * @returns {Record<string, string>} the merged config
 */
export function saveConfig(updates) {
    const current = loadConfig();
    const merged = { ...current };

    for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(updates || {}, key)) {
            const value = updates[key];
            merged[key] = value == null ? '' : String(value);
        }
    }

    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (err) {
        console.error('[Config] Failed to write config file:', err.message);
        throw err;
    }

    return merged;
}

/**
 * Returns the current resolved values for all settings keys.
 * @returns {Record<string, string>}
 */
export function getAllSettings() {
    const result = {};
    for (const key of SETTINGS_KEYS) {
        result[key] = getKey(key);
    }
    return result;
}

export { CONFIG_PATH };
