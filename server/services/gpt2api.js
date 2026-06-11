/**
 * gpt2api.js
 *
 * gpt2api.com（OpenAI 兼容下游接口）服务封装。
 * 统一支持文本 / 图像 / 视频；图像与视频走异步任务 + 轮询。
 *
 * 接入地址形如 https://www.gpt2api.com/v1
 * 鉴权：Authorization: Bearer sk-xxx
 */

// gpt2api 提供的模型 ID（用于在生成路由里判断走哪个提供商）
export const GPT2API_IMAGE_MODELS = ['nano-banana-pro', 'nano-banana-v2', 'nano-banana', 'gpt-image-2'];
export const GPT2API_VIDEO_MODELS = ['grok-imagine-video', 'sora', 'veo3.1', 'veo3.1-flash', 'veo3.1-lite'];

export const isGpt2apiImageModel = (id) => GPT2API_IMAGE_MODELS.includes(id);
export const isGpt2apiVideoModel = (id) => GPT2API_VIDEO_MODELS.includes(id);

// 宽高比 → 基准像素尺寸（gpt2api 会按 quality 档自动放大到精确尺寸）
const RATIO_TO_SIZE = {
    'Auto': '1024x1024',
    '1:1': '1024x1024',
    '3:2': '1264x848',
    '2:3': '848x1264',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '5:4': '1152x928',
    '4:5': '928x1152',
    '16:9': '1376x768',
    '9:16': '768x1376',
    '21:9': '1584x672',
};

// 图像分辨率档 → quality
const RES_TO_IMAGE_QUALITY = { '1K': '1k', '2K': '2k', '4K': '4k' };
// 视频分辨率 → quality
const RES_TO_VIDEO_QUALITY = { '720p': 'hd', '1080p': 'fullhd' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确保为 data URL（gpt2api 接受 data:image/...;base64,... 或公网 URL） */
function toImageInput(value) {
    if (!value) return null;
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('data:')) return value;
    return `data:image/png;base64,${value}`;
}

function authHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
}

/** 轮询一个异步任务直到完成，返回 result.data[0]（含绝对 url） */
async function pollTask(pollUrl, apiKey, { timeoutMs = 600000 } = {}) {
    const start = Date.now();
    let interval = 3000;

    while (true) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('gpt2api 任务超时');
        }

        const res = await fetch(pollUrl, { headers: authHeaders(apiKey) });
        const retryHeader = parseInt(res.headers.get('Retry-After') || '', 10);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(data?.error?.message || data?.error || `轮询失败 (HTTP ${res.status})`);
        }

        const status = data.status;
        if (status === 'succeeded') {
            const item = data?.result?.data?.[0];
            if (!item || !item.url) throw new Error('gpt2api 返回结果缺少 url');
            return item;
        }
        if (status === 'failed' || status === 'refunded') {
            throw new Error(data?.error?.message || data?.error || 'gpt2api 任务失败');
        }

        // queued / running：按 retry_after 间隔继续
        const retryAfter = Number.isFinite(retryHeader) ? retryHeader
            : (Number.isFinite(data.retry_after) ? data.retry_after : 3);
        interval = Math.max(2000, retryAfter * 1000);
        await sleep(interval);
    }
}

async function downloadToBuffer(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载生成结果失败 (HTTP ${resp.status})`);
    return Buffer.from(await resp.arrayBuffer());
}

/** 尝试从一次性（同步）响应里直接取出结果项；取不到返回 null */
function extractSyncItem(data) {
    const arr = data?.result?.data || data?.data;
    if (Array.isArray(arr) && arr.length > 0) {
        const it = arr[0];
        if (it && (it.url || it.b64_json)) return it;
    }
    return null;
}

/**
 * 图像生成（文生图 / 图生图）。返回 { buffer, format }。
 */
export async function generateGpt2apiImage({ prompt, imageBase64Array, aspectRatio, resolution, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const refs = (imageBase64Array || []).map(toImageInput).filter(Boolean);
    const hasRef = refs.length > 0;

    const body = {
        model,
        prompt: prompt || '',
        n: 1,
        size: RATIO_TO_SIZE[aspectRatio] || '1024x1024',
        quality: RES_TO_IMAGE_QUALITY[resolution] || '1k',
        async: true,
    };
    if (hasRef) {
        if (refs.length === 1) body.image = refs[0];
        else body.images = refs;
    }

    // 有参考图用 /images/edits，否则 /images/generations
    const endpoint = hasRef ? `${base}/images/edits` : `${base}/images/generations`;

    const res = await fetch(endpoint, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `图像请求失败 (HTTP ${res.status})`);

    // 同步返回：直接取结果
    let item = extractSyncItem(data);
    if (!item) {
        // 异步：轮询任务
        const taskId = data.task_id || data.id;
        if (!taskId) throw new Error('图像接口未返回结果或 task_id');
        item = await pollTask(`${base}/images/generations/${taskId}`, apiKey, { timeoutMs: 300000 });
    }

    if (item.url) {
        const buffer = await downloadToBuffer(item.url);
        const format = item.url.includes('.jpg') || item.url.includes('.jpeg') ? 'jpg' : 'png';
        return { buffer, format };
    }
    // 兼容 b64_json 形式
    return { buffer: Buffer.from(item.b64_json, 'base64'), format: 'png' };
}

/**
 * 视频生成（文生视频 / 图生视频）。返回 Buffer(mp4)。
 */
export async function generateGpt2apiVideo({ prompt, imageBase64, lastFrameBase64, aspectRatio, resolution, duration, model, baseUrl, apiKey }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const startImg = toImageInput(imageBase64);
    const body = {
        model,
        prompt: prompt || '',
        duration: duration || 6,
        async: true,
    };
    if (aspectRatio && aspectRatio !== 'Auto') body.ratio = aspectRatio;
    if (resolution && RES_TO_VIDEO_QUALITY[resolution]) body.quality = RES_TO_VIDEO_QUALITY[resolution];
    if (startImg) body.image = startImg;

    const res = await fetch(`${base}/video/generations`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `视频请求失败 (HTTP ${res.status})`);

    let item = extractSyncItem(data);
    if (!item) {
        const taskId = data.task_id || data.id;
        if (!taskId) throw new Error('视频接口未返回结果或 task_id');
        item = await pollTask(`${base}/video/generations/${taskId}`, apiKey, { timeoutMs: 900000 });
    }
    return await downloadToBuffer(item.url);
}

/**
 * 文本对话（OpenAI 兼容）。返回模型回复字符串。
 * 使用 SSE 流式接收再拼装：慢速推理模型（如 gpt-5 系列）非流式请求
 * 容易被中转网关 1~2 分钟超时掐断，流式则不受影响。
 */
export async function gpt2apiChat({ messages, model, baseUrl, apiKey, temperature = 0.7, maxTokens }) {
    if (!apiKey) throw new Error('未配置 gpt2api API Key（请在「设置」中填写）');
    const base = (baseUrl || 'https://www.gpt2api.com/v1').replace(/\/+$/, '');

    const body = { model, messages, temperature, stream: true };
    if (maxTokens) body.max_tokens = maxTokens;

    const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `gpt2api 文本请求失败 (HTTP ${res.status})`);
    }

    const contentType = res.headers.get('content-type') || '';
    // 部分网关会忽略 stream 参数直接返回 JSON，做好兼容
    if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data?.error) throw new Error(data.error.message || data.error);
        return data?.choices?.[0]?.message?.content || '';
    }

    // 解析 SSE 流，拼接 delta.content
    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 留下不完整的最后一行
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                if (json?.error) throw new Error(json.error.message || json.error);
                const delta = json?.choices?.[0]?.delta?.content;
                if (delta) full += delta;
            } catch (e) {
                if (e instanceof SyntaxError) continue; // 跳过非 JSON 行
                throw e;
            }
        }
    }
    return full;
}
