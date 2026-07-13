/**
 * OpenAI 兼容的文字/图片多模态调用。
 * 多模态失败时绝不降级为纯文本，避免脱离商品图进行臆测。
 */
import fs from 'fs';
import path from 'path';
import { getKey } from '../config.js';
import { gpt2apiChat } from '../services/gpt2api.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRYABLE = /429|500|502|503|504|timeout|timed out|rate|limit|temporar|unavailable|busy|网络|超时|限流|繁忙/i;
const UNSUPPORTED_IMAGE = /image_url|image input|vision|multimodal|multi-modal|unsupported.*image|does not support.*image|图片.*不支持|不支持.*图片|多模态.*不支持/i;

function textConfig() {
    const apiKey = getKey('TEXT_API_KEY');
    if (!apiKey) throw new Error('请先在设置中配置文字模型 API Key');
    return {
        apiKey,
        baseUrl: getKey('TEXT_API_URL'),
        model: getKey('TEXT_MODEL') || 'grok-4.20-fast',
    };
}

function mimeFor(file) {
    return {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    }[path.extname(file).toLowerCase()] || 'image/png';
}

/** 将本地 library URL 转成 data URL；公网图片保持 URL 形式。 */
function normalizeImageUrl(imageUrl, libraryDir) {
    const input = String(imageUrl || '').trim();
    if (!input) throw new Error('商品图片不能为空');
    if (input.startsWith('data:image/')) return input;

    let pathname = input;
    let remote = false;
    if (/^https?:\/\//i.test(input)) {
        const parsed = new URL(input);
        pathname = parsed.pathname;
        remote = !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
        if (remote || !pathname.startsWith('/library/')) return input;
    }

    if (!pathname.startsWith('/library/')) {
        throw new Error('商品图片地址无效：请提供公网 URL、图片 data URL 或 /library/ 本地图片');
    }
    const root = path.resolve(libraryDir || process.env.LIBRARY_DIR || path.join(process.cwd(), 'library'));
    const relative = decodeURIComponent(pathname.split('?')[0].slice('/library/'.length));
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        throw new Error('商品图片路径无效');
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error('商品图片文件不存在');
    }
    return `data:${mimeFor(file)};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function runWithRetry(options, { retries = 3, initialDelayMs = 1200, label = '模型调用' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const reply = await gpt2apiChat({ ...textConfig(), ...options });
            if (!String(reply || '').trim()) throw new Error('模型返回内容为空');
            return reply;
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error);
            console.warn(`[multimodal-chat] ${label} 第 ${attempt + 1}/${retries + 1} 次失败: ${message}`);
            if (attempt >= retries || (!RETRYABLE.test(message) && message !== '模型返回内容为空')) break;
            await sleep(initialDelayMs * (2 ** attempt));
        }
    }
    throw lastError || new Error(`${label}失败`);
}

export async function textChat({
    system,
    prompt,
    maxTokens = 12000,
    temperature = 0.5,
    retries = 3,
    onDelta,
}) {
    return runWithRetry({
        messages: [
            { role: 'system', content: String(system || '') },
            { role: 'user', content: String(prompt || '') },
        ],
        maxTokens,
        temperature,
        onDelta,
    }, { retries, label: '文字模型调用' });
}

export async function multimodalChat({
    system,
    prompt,
    imageUrl,
    imageUrls,
    libraryDir,
    maxTokens = 12000,
    temperature = 0.4,
    retries = 3,
    onDelta,
}) {
    const inputs = Array.isArray(imageUrls) && imageUrls.length
        ? imageUrls
        : [imageUrl];
    const resolvedImages = Array.from(new Set(inputs.filter(Boolean)))
        .slice(0, 6)
        .map(input => normalizeImageUrl(input, libraryDir));
    if (!resolvedImages.length) throw new Error('商品图片不能为空');
    const messages = [
        { role: 'system', content: String(system || '') },
        {
            role: 'user',
            content: [
                { type: 'text', text: String(prompt || '') },
                ...resolvedImages.map(url => ({
                    type: 'image_url',
                    image_url: { url, detail: 'high' },
                })),
            ],
        },
    ];

    try {
        return await runWithRetry({
            messages,
            maxTokens,
            temperature,
            onDelta,
        }, { retries, label: '商品图片多模态分析' });
    } catch (error) {
        const detail = String(error?.message || error);
        if (UNSUPPORTED_IMAGE.test(detail)) {
            throw new Error(`当前文字模型不支持图像输入，请在设置中选择支持视觉多模态的模型。上游信息：${detail}`);
        }
        throw new Error(`商品图片多模态分析失败，未降级为纯文本分析。${detail}`);
    }
}

export { normalizeImageUrl };
