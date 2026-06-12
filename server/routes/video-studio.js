/**
 * video-studio.js
 *
 * 视频剪辑工作室后端：
 * - TTS 语音生成（msedge-tts，微软 Edge 朗读接口，免费无需密钥）
 * - AI 解说脚本生成（复用「设置」里的文字模型）
 * - ffmpeg 导出合成：多片段裁剪 + xfade 转场 + drawtext 字幕烧录 + 配音混音
 *
 * ffmpeg 使用 ffmpeg-static 内置二进制（打包进应用，开箱即用），
 * 若不可用则回退系统 PATH 中的 ffmpeg。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { getKey } from '../config.js';
import { gpt2apiChat } from '../services/gpt2api.js';

const router = express.Router();

// ============================================================================
// FFMPEG 基础
// ============================================================================

function getFfmpegPath() {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
    return 'ffmpeg';
}

/** 运行 ffmpeg，返回 stderr（ffmpeg 的日志都在 stderr） */
function runFfmpeg(args, { timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('ffmpeg 处理超时'));
        }, timeoutMs);

        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stderr);
            else reject(new Error(`ffmpeg 失败 (code ${code}): ${stderr.slice(-800)}`));
        });
        proc.on('error', err => {
            clearTimeout(timer);
            reject(new Error(`ffmpeg 启动失败: ${err.message}`));
        });
    });
}

/** 探测媒体文件信息：时长（秒）与是否含音频流 */
async function probeMedia(filePath) {
    let stderr = '';
    try {
        await runFfmpeg(['-hide_banner', '-i', filePath], { timeoutMs: 30000 });
    } catch (err) {
        stderr = err.message; // ffmpeg -i 无输出文件必然非 0 退出，信息在错误里
    }
    const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    let duration = 0;
    if (durMatch) {
        duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 +
            parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
    }
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);
    return { duration, hasAudio };
}

/** 把 /library/... 或 http://localhost:.../library/... 的 URL 解析为本地文件路径 */
function resolveLibraryPath(url, libraryDir) {
    if (!url) return null;
    let p = url;
    try {
        if (p.startsWith('http')) p = new URL(p).pathname;
    } catch (_) { /* 按路径处理 */ }
    p = decodeURIComponent(p);
    if (!p.startsWith('/library/')) return null;
    const rel = p.replace('/library/', '');
    const full = path.join(libraryDir, rel);
    // 防止路径穿越
    if (!full.startsWith(path.resolve(libraryDir))) return null;
    return fs.existsSync(full) ? full : null;
}

/** 找一个支持中文的 Windows 字体用于字幕 */
function findSubtitleFont() {
    const candidates = [
        'C:\\Windows\\Fonts\\msyhbd.ttc', // 微软雅黑 粗体
        'C:\\Windows\\Fonts\\msyh.ttc',   // 微软雅黑
        'C:\\Windows\\Fonts\\simhei.ttf', // 黑体
        'C:\\Windows\\Fonts\\simsun.ttc', // 宋体
        'C:\\Windows\\Fonts\\arialbd.ttf',
        'C:\\Windows\\Fonts\\arial.ttf',
    ];
    for (const f of candidates) {
        if (fs.existsSync(f)) return f;
    }
    return null;
}

/** drawtext fontfile 路径转义（Windows 盘符冒号需要转义） */
function escapeFontPath(p) {
    return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ============================================================================
// 音色列表（Edge TTS 常用中文/英文音色，免联网拉取）
// ============================================================================

const VOICES = [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声 · 温暖）' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声 · 活泼）' },
    { id: 'zh-CN-YunxiNeural', name: '云希（男声 · 阳光）' },
    { id: 'zh-CN-YunjianNeural', name: '云健（男声 · 浑厚解说）' },
    { id: 'zh-CN-YunyangNeural', name: '云扬（男声 · 新闻播报）' },
    { id: 'zh-CN-YunxiaNeural', name: '云夏（男童声）' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北话 · 女声）' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西话 · 女声）' },
    { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台湾 · 女声）' },
    { id: 'en-US-JennyNeural', name: 'Jenny（英语 · 女声）' },
    { id: 'en-US-GuyNeural', name: 'Guy（英语 · 男声）' },
];

router.get('/voices', (req, res) => {
    res.json({ voices: VOICES });
});

// ============================================================================
// TTS 语音生成
// ============================================================================

router.post('/tts', async (req, res) => {
    try {
        const { text, voice } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ error: '请输入要合成的文本' });
        }
        const { LIBRARY_DIR } = req.app.locals;
        const audioDir = path.join(LIBRARY_DIR, 'assets');
        fs.mkdirSync(audioDir, { recursive: true });

        const voiceId = voice || 'zh-CN-XiaoxiaoNeural';
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text.trim());

        const filename = `tts_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp3`;
        const filePath = path.join(audioDir, filename);

        await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(filePath);
            audioStream.pipe(ws);
            audioStream.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', resolve);
        });

        const { duration } = await probeMedia(filePath);
        if (!duration) {
            fs.unlinkSync(filePath);
            throw new Error('语音生成失败（音频为空），请重试');
        }

        res.json({ url: `/library/assets/${filename}`, duration, text: text.trim(), voice: voiceId });
    } catch (error) {
        console.error('[VideoStudio] TTS error:', error);
        res.status(500).json({ error: error.message || '语音生成失败' });
    }
});

// ============================================================================
// AI 解说脚本生成（复用文字模型设置）
// ============================================================================

router.post('/script', async (req, res) => {
    try {
        const { prompt, durationHint } = req.body;
        const apiKey = getKey('TEXT_API_KEY');
        if (!apiKey) {
            return res.status(500).json({ error: '未配置文字模型 KEY，请在「设置」中填写' });
        }
        const messages = [
            {
                role: 'system',
                content: '你是短视频解说文案专家。根据用户的主题写一段适合配音朗读的中文解说词。要求：口语化、有感染力、不要任何标题/序号/表情符号/舞台说明，只输出解说正文。用句号分句，便于逐句配音。' +
                    (durationHint ? `全文朗读时长控制在约 ${durationHint} 秒（约 ${Math.round(durationHint * 4.5)} 个字以内）。` : '全文控制在 100 字以内。')
            },
            { role: 'user', content: prompt || '为我的视频写一段精彩的解说词' },
        ];
        const script = await gpt2apiChat({
            messages,
            model: getKey('TEXT_MODEL') || 'grok-4.20-fast',
            baseUrl: getKey('TEXT_API_URL'),
            apiKey,
            temperature: 0.8,
        });
        res.json({ script: (script || '').trim() });
    } catch (error) {
        console.error('[VideoStudio] Script error:', error);
        res.status(500).json({ error: error.message || '脚本生成失败' });
    }
});

// ============================================================================
// 智能字幕：语音识别（OpenAI 兼容 /audio/transcriptions 接口）
// ============================================================================

/** 去掉字幕末尾的标点（字幕惯例：句中标点保留，句尾标点不显示） */
function stripTrailingPunct(s) {
    const t = String(s).replace(/[，。！？、；：…,.!?;:\s]+$/u, '');
    return t || String(s).trim(); // 全是标点的极端情况保留原文
}

/** 单字符视觉宽度：中日韩全角记 1，拉丁/数字等半角记 0.55（maxLen 以「中文字数」为单位） */
function charW(ch) {
    return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/.test(ch) ? 1 : 0.55;
}
function visualLen(s) {
    let n = 0;
    for (const ch of String(s)) n += charW(ch);
    return n;
}

/** 超长文本均衡硬切：按 ceil(总宽/上限) 份均分（10 字切成 5+5 而不是 9+1），拉丁文优先在空格处断 */
function hardSplit(str, maxLen) {
    let buf = String(str).trim();
    const total = visualLen(buf);
    if (total <= maxLen) return buf ? [buf] : [];
    const n = Math.ceil(total / maxLen);
    const target = total / n;
    const out = [];
    while (out.length < n - 1 && buf) {
        let acc = 0;
        let cut = buf.length;
        for (let i = 0; i < buf.length; i++) {
            acc += charW(buf[i]);
            if (acc >= target) { cut = i + 1; break; }
        }
        // 含空格的文本（英文/西语等）把切点移到单词边界：先向后找（不超过 maxLen），再向前找
        if (buf.includes(' ')) {
            let fwd = -1;
            let w = acc;
            for (let j = cut; j < buf.length; j++) {
                if (buf[j] === ' ') { fwd = j; break; }
                w += charW(buf[j]);
                if (w > maxLen) break;
            }
            if (fwd >= 0) {
                cut = fwd;
            } else {
                const lastSpace = buf.slice(0, cut + 1).lastIndexOf(' ');
                if (lastSpace > cut * 0.3) cut = lastSpace;
            }
        }
        out.push(buf.slice(0, cut).trim());
        buf = buf.slice(cut).trim();
    }
    if (buf) out.push(buf);
    return out.filter(Boolean);
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;

/** 把识别文本切成适合做字幕的短句：先按句末标点切，过长的再按逗号细分，仍超长则均衡硬切 */
function splitSubtitleText(text, maxLen = 22) {
    const sentences = String(text).split(/(?<=[。！？!?；;…])|\n+/).map(s => s.trim()).filter(Boolean);
    const pieces = [];
    for (const sent of sentences) {
        // 长度按去掉句尾标点后计算（句尾标点最终不显示，不应导致多切一条）
        if (visualLen(stripTrailingPunct(sent)) <= maxLen) { pieces.push(sent); continue; }
        const parts = sent.split(/(?<=[，,、：:])/).map(s => s.trim()).filter(Boolean);
        let buf = '';
        for (const part of parts) {
            if (buf && (visualLen(buf) + visualLen(stripTrailingPunct(part))) > maxLen) {
                pieces.push(...hardSplit(stripTrailingPunct(buf), maxLen));
                buf = part;
            } else {
                buf += (buf && !buf.endsWith(' ') && /^[a-zA-Z]/.test(part) ? ' ' : '') + part;
            }
        }
        if (buf) pieces.push(...hardSplit(stripTrailingPunct(buf), maxLen));
    }
    return pieces.map(stripTrailingPunct).filter(p => !PUNCT_ONLY.test(p));
}

/** 用 ffmpeg silencedetect 找语音区间（秒，相对音频开头）；失败时退化为整段 */
async function detectSpeechIntervals(audioPath, totalDur) {
    let stderr = '';
    try {
        stderr = await runFfmpeg(['-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { timeoutMs: 60000 });
    } catch (_) {
        return [[0, totalDur]];
    }
    const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map(m => Math.max(0, +m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => +m[1]);
    // 组装静音区间（结尾静音可能只有 start 没有 end）
    const silences = starts.map((s, i) => [s, ends[i] !== undefined ? ends[i] : totalDur]);
    // 取补集 = 语音区间，过滤掉极短的碎片
    const intervals = [];
    let cur = 0;
    for (const [s, e] of silences) {
        if (s - cur >= 0.15) intervals.push([cur, s]);
        cur = Math.max(cur, e);
    }
    if (totalDur - cur >= 0.15) intervals.push([cur, totalDur]);
    return intervals.length > 0 ? intervals : [[0, totalDur]];
}

/** 合并过碎的语音区间：间隔很小或区间过短（说话中的换气/顿挫被误判为静音）时并入相邻区间 */
function mergeShortIntervals(intervals, minDur = 0.5, maxGap = 0.35) {
    if (!intervals || intervals.length <= 1) return intervals;
    const out = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
        const prev = out[out.length - 1];
        const [s, e] = intervals[i];
        const gap = s - prev[1];
        const tooShort = (e - s) < minDur || (prev[1] - prev[0]) < minDur;
        if (gap <= maxGap || (tooShort && gap <= 0.8)) prev[1] = e;
        else out.push([s, e]);
    }
    return out;
}

/** 把字幕条分配到语音区间：条数与区间数一致则一一对应，否则按字数比例在语音时间内分配（跳过静音） */
function allocateBySpeech(pieces, intervals, fallbackDur) {
    if (!intervals || intervals.length === 0) intervals = [[0, fallbackDur]];
    if (intervals.length === pieces.length) {
        return pieces.map((p, i) => ({ text: p, start: intervals[i][0], end: intervals[i][1] }));
    }
    const speechTotal = intervals.reduce((n, [a, b]) => n + (b - a), 0) || fallbackDur;
    const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
    // 语音时间（去掉静音后的累计时长）→ 真实时间
    const toReal = (st) => {
        let acc = 0;
        for (const [a, b] of intervals) {
            const len = b - a;
            if (st <= acc + len) return a + (st - acc);
            acc += len;
        }
        return intervals[intervals.length - 1][1];
    };
    const out = [];
    let cursor = 0;
    for (const p of pieces) {
        const d = speechTotal * (p.length / totalChars);
        out.push({ text: p, start: toReal(cursor), end: toReal(cursor + d) });
        cursor += d;
    }
    return out;
}

router.post('/transcribe', async (req, res) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcasr-'));
    try {
        // segments: [{ url, inPoint, outPoint, start, speed }]（start 为时间轴起点秒）
        // maxLen: 单条字幕最大字数（前端按导出分辨率/字号计算，竖屏更短）
        const { segments, language, maxLen: maxLenRaw } = req.body;
        const maxLen = Math.max(6, Math.min(30, Number(maxLenRaw) || 16));
        if (!Array.isArray(segments) || segments.length === 0) {
            return res.status(400).json({ error: '没有可识别的音频/视频片段' });
        }
        const { LIBRARY_DIR } = req.app.locals;
        const baseUrl = (getKey('ASR_API_URL') || getKey('TEXT_API_URL') || '').replace(/\/+$/, '');
        const apiKey = getKey('ASR_API_KEY') || getKey('TEXT_API_KEY');
        const model = getKey('ASR_MODEL') || 'whisper-1';
        if (!baseUrl) return res.status(500).json({ error: '未配置语音识别接口地址，请在「设置 → 语音识别」中填写' });
        if (!apiKey) return res.status(500).json({ error: '未配置语音识别 KEY，请在「设置 → 语音识别」中填写' });

        const out = [];
        let recognizedAny = false;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const src = resolveLibraryPath(seg.url, LIBRARY_DIR);
            if (!src) continue;
            const inP = Math.max(0, Number(seg.inPoint) || 0);
            const outP = Math.max(inP + 0.05, Number(seg.outPoint) || (inP + 0.05));
            const speed = Math.max(0.1, Number(seg.speed) || 1);
            const segStart = Math.max(0, Number(seg.start) || 0);

            // 抽出该片段的音频（16kHz 单声道 mp3，识别接口体积友好）
            const clipAudio = path.join(tmpDir, `seg_${i}.mp3`);
            try {
                await runFfmpeg([
                    '-y', '-ss', inP.toFixed(3), '-to', outP.toFixed(3), '-i', src,
                    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', clipAudio,
                ], { timeoutMs: 120000 });
            } catch (_) {
                continue; // 无音轨等情况直接跳过该片段
            }
            if (!fs.existsSync(clipAudio) || fs.statSync(clipAudio).size < 1000) continue;

            // 识别结果时间是相对截取后音频的，映射回时间轴：t = 片段时间轴起点 + 识别时间 / 倍速
            const toTimeline = (srcT) => segStart + Math.max(0, Number(srcT) || 0) / speed;
            const srcDur = outP - inP; // 截取音频时长（秒）

            // MiMo ASR（小米 mimo-v2.5-asr）：chat/completions + input_audio，鉴权用 api-key 头
            const isMimoAsr = /mimo.*asr/i.test(model) || /xiaomimimo\.com/i.test(baseUrl);
            if (isMimoAsr) {
                const callMimo = async (audioPath) => {
                    const b64 = fs.readFileSync(audioPath).toString('base64');
                    if (b64.length > 10 * 1024 * 1024) {
                        throw new Error('音频片段过长（Base64 超过 10MB），请缩短片段后重试');
                    }
                    const resp = await fetch(`${baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model,
                            messages: [{
                                role: 'user',
                                content: [{ type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${b64}` } }],
                            }],
                            asr_options: { language: language || 'auto' },
                        }),
                    });
                    const bodyText = await resp.text();
                    if (!resp.ok) {
                        throw new Error(`语音识别失败 (${resp.status}): ${bodyText.slice(0, 200)}`);
                    }
                    let data;
                    try { data = JSON.parse(bodyText); } catch (_) { data = {}; }
                    return String(data?.choices?.[0]?.message?.content || '').trim();
                };

                // MiMo 不返回时间戳 → 用 silencedetect 把音频按静音切成若干「语音区间」，
                // 每个区间单独识别：字幕时间 = 该区间的真实起止时间，和声音严格对齐
                const intervals = mergeShortIntervals(await detectSpeechIntervals(clipAudio, srcDur));
                let segRecognized = false;
                for (let k = 0; k < intervals.length; k++) {
                    const [ivS, ivE] = intervals[k];
                    let text = '';
                    let chunkOk = false;
                    // 区间过多时不再细分（>24 段说明是连续说话，silencedetect 切碎了），整段识别
                    if (intervals.length > 1 && intervals.length <= 24) {
                        const chunkAudio = path.join(tmpDir, `seg_${i}_iv${k}.mp3`);
                        try {
                            await runFfmpeg([
                                '-y', '-ss', Math.max(0, ivS - 0.05).toFixed(3), '-to', Math.min(srcDur, ivE + 0.05).toFixed(3),
                                '-i', clipAudio, '-ac', '1', '-ar', '16000', '-b:a', '48k', chunkAudio,
                            ], { timeoutMs: 60000 });
                            if (fs.existsSync(chunkAudio) && fs.statSync(chunkAudio).size > 500) {
                                text = await callMimo(chunkAudio);
                                chunkOk = true;
                            }
                        } catch (_) { /* 切块失败 → 退回整段识别 */ }
                    }
                    if (!chunkOk) {
                        // 单区间或切块失败：整段识别一次，按字数比例分配到语音区间
                        const whole = await callMimo(clipAudio);
                        if (whole) {
                            const pieces = splitSubtitleText(whole, maxLen);
                            const timed = allocateBySpeech(pieces, intervals, srcDur);
                            for (const t of timed) {
                                out.push({
                                    start: +toTimeline(t.start).toFixed(2),
                                    end: +toTimeline(Math.max(t.end, t.start + 0.3)).toFixed(2),
                                    text: t.text,
                                });
                            }
                            if (pieces.length > 0) segRecognized = true;
                        }
                        break; // 整段已处理完，不再逐区间
                    }
                    // 只有标点/空白的识别结果（换气、杂音被识别成「。」等）直接丢弃
                    if (!text || /^[\s\p{P}\p{S}]+$/u.test(text)) continue;
                    // 该区间的文本：不超长直接用区间时间；超长再按字数比例在区间内细分
                    const pieces = splitSubtitleText(text, maxLen);
                    const timed = allocateBySpeech(pieces, [[ivS, ivE]], ivE - ivS);
                    for (const t of timed) {
                        out.push({
                            start: +toTimeline(t.start).toFixed(2),
                            end: +toTimeline(Math.max(t.end, t.start + 0.3)).toFixed(2),
                            text: t.text,
                        });
                    }
                    if (pieces.length > 0) segRecognized = true;
                }
                if (segRecognized) recognizedAny = true;
                continue;
            }

            // OpenAI Whisper 兼容（/audio/transcriptions，multipart）
            const form = new FormData();
            form.append('file', new Blob([fs.readFileSync(clipAudio)], { type: 'audio/mpeg' }), `seg_${i}.mp3`);
            form.append('model', model);
            form.append('response_format', 'verbose_json');
            if (language) form.append('language', language);

            const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
            });
            const bodyText = await resp.text();
            if (!resp.ok) {
                if (resp.status === 404 || resp.status === 405) {
                    throw new Error('当前接口不支持语音识别（/audio/transcriptions）。请在「设置 → 语音识别」中配置支持 Whisper 的服务地址与 KEY。');
                }
                throw new Error(`语音识别失败 (${resp.status}): ${bodyText.slice(0, 200)}`);
            }
            let data;
            try { data = JSON.parse(bodyText); } catch (_) { data = { text: bodyText }; }

            if (Array.isArray(data.segments) && data.segments.length > 0) {
                for (const s of data.segments) {
                    const txt = String(s.text || '').trim();
                    if (!txt) continue;
                    out.push({ start: +toTimeline(s.start).toFixed(2), end: +toTimeline(s.end).toFixed(2), text: stripTrailingPunct(txt) });
                }
                recognizedAny = true;
            } else if (data.text && String(data.text).trim()) {
                out.push({
                    start: +toTimeline(0).toFixed(2),
                    end: +toTimeline(srcDur).toFixed(2),
                    text: stripTrailingPunct(String(data.text).trim()),
                });
                recognizedAny = true;
            }
        }

        if (!recognizedAny) {
            return res.json({ subtitles: [], message: '未识别到有效语音（片段可能没有人声或无音轨）' });
        }
        out.sort((a, b) => a.start - b.start);
        res.json({ subtitles: out });
    } catch (error) {
        console.error('[VideoStudio] Transcribe error:', error);
        res.status(500).json({ error: error.message || '语音识别失败' });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略清理失败 */ }
    }
});

// ============================================================================
// 音乐 / 音频上传（BGM 等，存入素材目录）
// ============================================================================

router.post('/upload-audio', async (req, res) => {
    try {
        const { filename, dataBase64 } = req.body;
        if (!dataBase64) return res.status(400).json({ error: '缺少音频数据' });
        const { LIBRARY_DIR } = req.app.locals;
        const audioDir = path.join(LIBRARY_DIR, 'assets');
        fs.mkdirSync(audioDir, { recursive: true });

        const extMatch = String(filename || '').match(/\.(mp3|wav|m4a|aac|ogg|flac)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'mp3';
        const outName = `bgm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
        const outPath = path.join(audioDir, outName);

        const base64 = dataBase64.replace(/^data:[^;]+;base64,/, '');
        fs.writeFileSync(outPath, base64, 'base64');

        const { duration } = await probeMedia(outPath);
        if (!duration) {
            fs.unlinkSync(outPath);
            return res.status(400).json({ error: '无法识别该音频文件' });
        }
        res.json({ url: `/library/assets/${outName}`, duration, name: filename || outName });
    } catch (error) {
        console.error('[VideoStudio] Upload audio error:', error);
        res.status(500).json({ error: error.message || '音频上传失败' });
    }
});

// ============================================================================
// 导出合成
// ============================================================================

// 片段特效预设（id → ffmpeg 滤镜片段）
const FX_FILTERS = {
    bw: 'hue=s=0',
    vivid: 'eq=saturation=1.45:contrast=1.08',
    sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
    cold: 'colorbalance=bs=.18:rs=-.05',
    warm: 'colorbalance=rs=.16:bs=-.12',
    vignette: 'vignette=PI/4.5',
    blur: 'gblur=sigma=8',
    oldfilm: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,noise=alls=10:allf=t,vignette=PI/4.5',
    sharpen: 'unsharp=5:5:1.0',
    grain: 'noise=alls=14:allf=t+u',
    pixel: 'pixelize=w=16:h=16',
    negative: 'negate',
    vintage: 'curves=preset=vintage',
    crossprocess: 'curves=preset=cross_process',
    strongcontrast: 'curves=preset=strong_contrast',
    tealorange: 'colorbalance=rs=.2:bs=-.2,eq=saturation=1.25',
    dreampurple: 'colorbalance=rs=.1:bs=.25',
    sketch: 'edgedetect=mode=colormix:high=0.9',
};

/** 把任意速度拆成 ffmpeg atempo 允许的 0.5~2.0 链 */
function buildAtempoChain(speed) {
    const parts = [];
    let s = speed;
    while (s > 2.0) { parts.push('atempo=2.0'); s /= 2.0; }
    while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
    if (Math.abs(s - 1) > 0.001) parts.push(`atempo=${s.toFixed(4)}`);
    return parts;
}

/**
 * 请求体：
 * {
 *   clips: [{ url, inPoint, outPoint }],            // 按顺序的片段（必填，>=1）
 *   transitions: [{ type, duration }],              // 长度 = clips.length - 1；type: none|fade|wipeleft|wiperight|slideup|slidedown|circleopen|dissolve
 *   subtitles: [{ text, start, end }],              // 全局时间轴（秒）
 *   subtitleStyle: { position, fontScale, color, outlineColor, background }, // 字幕样式（全局）
 *   audios: [{ url, start, volume }],               // 配音（全局时间轴）
 *   width, height, fps                              // 输出参数
 * }
 */
router.post('/export', async (req, res) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcstudio-'));
    try {
        const { clips, transitions = [], subtitles = [], subtitleStyle = {}, audios = [], width = 1280, height = 720, fps = 30 } = req.body;
        const { LIBRARY_DIR, VIDEOS_DIR } = req.app.locals;

        if (!Array.isArray(clips) || clips.length === 0) {
            return res.status(400).json({ error: '时间轴上没有视频片段' });
        }

        const videoTrackMuted = req.body.videoTrackMuted === true;
        const audioTrackMuted = req.body.audioTrackMuted === true;

        // 解析片段文件（含变速/静音/倒放/旋转翻转/画面调节；支持图片素材）
        const clipInfos = [];
        for (const c of clips) {
            const file = resolveLibraryPath(c.url, LIBRARY_DIR);
            if (!file) return res.status(400).json({ error: `素材不存在: ${c.url}` });
            const isImage = /\.(png|jpe?g|webp|bmp|gif)$/i.test(file);
            const meta = isImage ? { duration: 1e9, hasAudio: false } : await probeMedia(file);
            // 图片：时间从 0 开始按时长计；视频：按入出点裁剪
            const inP = isImage ? 0 : Math.max(0, Number(c.inPoint) || 0);
            const outP = isImage
                ? Math.max(0.2, (Number(c.outPoint) || 4) - (Number(c.inPoint) || 0))
                : Math.min(meta.duration || 1e9, Number(c.outPoint) || meta.duration);
            if (outP - inP < 0.2) return res.status(400).json({ error: '存在过短的片段（<0.2 秒）' });
            const speed = Math.min(4, Math.max(0.25, Number(c.speed) || 1));
            const eq = c.eq || {};
            clipInfos.push({
                file, inP, outP, isImage, hasAudio: meta.hasAudio,
                speed,
                dur: (outP - inP) / speed, // 变速后的有效时长
                muted: c.muted === true,
                volume: c.volume != null ? Math.min(2, Math.max(0, Number(c.volume))) : 1,
                reverse: c.reverse === true,
                rotate: [0, 90, 180, 270].includes(Number(c.rotate)) ? Number(c.rotate) : 0,
                flipH: c.flipH === true,
                flipV: c.flipV === true,
                scale: Math.min(3, Math.max(0.2, Number(c.scale) || 1)),
                posX: Math.min(1, Math.max(-1, Number(c.posX) || 0)),
                posY: Math.min(1, Math.max(-1, Number(c.posY) || 0)),
                effect: FX_FILTERS[c.effect] ? c.effect : null,
                eq: {
                    brightness: Math.min(0.5, Math.max(-0.5, Number(eq.brightness) || 0)),
                    contrast: Math.min(2, Math.max(0.5, Number(eq.contrast) || 1)),
                    saturation: Math.min(3, Math.max(0, Number(eq.saturation) != null && !isNaN(Number(eq.saturation)) ? Number(eq.saturation) : 1)),
                },
            });
        }

        // 解析配音/音乐文件（含裁剪/变速/静音/淡入淡出）
        const audioInfos = [];
        for (const a of audios) {
            const file = resolveLibraryPath(a.url, LIBRARY_DIR);
            if (!file) continue; // 配音缺失不致命，跳过
            const srcDuration = Number(a.duration) || 0;
            const inP = Math.max(0, Number(a.inPoint) || 0);
            const outP = Number(a.outPoint) > inP ? Number(a.outPoint) : (srcDuration || 1e9);
            audioInfos.push({
                file,
                start: Math.max(0, Number(a.start) || 0),
                inP, outP,
                volume: a.muted === true ? 0 : (a.volume != null ? Math.min(2, Math.max(0, Number(a.volume))) : 1),
                speed: Math.min(4, Math.max(0.25, Number(a.speed) || 1)),
                fadeIn: Math.min(5, Math.max(0, Number(a.fadeIn) || 0)),
                fadeOut: Math.min(5, Math.max(0, Number(a.fadeOut) || 0)),
                srcDuration,
            });
        }

        // 解析贴纸（前端已渲染为 PNG dataURL）
        const stickerInfos = [];
        const rawStickers = Array.isArray(req.body.stickers) ? req.body.stickers : [];
        for (let i = 0; i < rawStickers.length; i++) {
            const s = rawStickers[i];
            if (!s || typeof s.data !== 'string' || !s.data.startsWith('data:image/png;base64,')) continue;
            const pngPath = path.join(tmpDir, `sticker_${i}.png`);
            fs.writeFileSync(pngPath, s.data.replace(/^data:image\/png;base64,/, ''), 'base64');
            stickerInfos.push({
                file: pngPath,
                x: Math.min(1, Math.max(0, Number(s.x) || 0.5)),
                y: Math.min(1, Math.max(0, Number(s.y) || 0.5)),
                size: Math.min(0.8, Math.max(0.05, Number(s.size) || 0.18)), // 相对画面高度
                start: Math.max(0, Number(s.start) || 0),
                end: Math.max(0.1, Number(s.end) || 3),
            });
        }

        const n = clipInfos.length;
        const inputs = [];
        clipInfos.forEach(ci => {
            if (ci.isImage) {
                // 图片：循环为指定时长的视频流（多留 1s 余量，由 trim 截断）
                inputs.push('-loop', '1', '-t', (ci.outP + 1).toFixed(3), '-i', ci.file);
            } else {
                inputs.push('-i', ci.file);
            }
        });
        audioInfos.forEach(ai => { inputs.push('-i', ai.file); });
        const stickerInputBase = n + audioInfos.length;
        stickerInfos.forEach(si => { inputs.push('-i', si.file); });

        // ---------- 构建 filtergraph ----------
        const F = [];

        // 预计算每个衔接处的有效转场时长（同时用于补垫与 xfade，确保一致）
        const XFADE_OK = (t) => t && t.type && t.type !== 'none';
        const tdList = [];
        for (let k = 0; k < n - 1; k++) {
            const t = transitions[k] || { type: 'none', duration: 0 };
            tdList.push(
                XFADE_OK(t)
                    ? Math.min(Math.max(Number(t.duration) || 0.5, 0.2), Math.min(clipInfos[k].dur, clipInfos[k + 1].dur) / 2)
                    : 0.04 // 硬切
            );
        }

        // 片段标准化（裁剪 → 倒放 → 变速 → 旋转/翻转 → 画面调节 → 统一尺寸）
        clipInfos.forEach((ci, i) => {
            const vParts = [
                `trim=start=${ci.inP}:end=${ci.outP}`,
                'setpts=PTS-STARTPTS',
            ];
            if (ci.reverse) vParts.push('reverse');
            if (ci.speed !== 1) vParts.push(`setpts=PTS/${ci.speed.toFixed(4)}`);
            if (ci.rotate === 90) vParts.push('transpose=1');
            else if (ci.rotate === 180) vParts.push('transpose=1', 'transpose=1');
            else if (ci.rotate === 270) vParts.push('transpose=2');
            if (ci.flipH) vParts.push('hflip');
            if (ci.flipV) vParts.push('vflip');
            const { brightness, contrast, saturation } = ci.eq;
            if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
                vParts.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`);
            }
            if (ci.effect) vParts.push(FX_FILTERS[ci.effect]);

            // 末帧克隆补垫：保证转场窗口内必有画面（修复"转场黑闪"——
            // 部分视频容器时长大于视频流实际时长，导致 xfade 落在流结束之后输出黑帧）
            const padOut = i < n - 1 ? (tdList[i] + 0.2) : 0;
            const tailPad = padOut > 0 ? `,tpad=stop_mode=clone:stop_duration=${padOut.toFixed(3)}` : '';

            const hasZoom = ci.scale !== 1 || ci.posX !== 0 || ci.posY !== 0;
            if (!hasZoom) {
                // 无缩放/位移：常规适配 + 黑边填充
                vParts.push(
                    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
                    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
                    `fps=${fps}`, 'format=yuv420p', 'settb=AVTB'
                );
                F.push(`[${i}:v]${vParts.join(',')}${tailPad}[v${i}]`);
            } else {
                // 缩放 + 位移：先适配再按比例缩放，叠加到黑色画布上（溢出自动裁剪）
                vParts.push(
                    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
                    `scale=trunc(iw*${ci.scale.toFixed(4)}/2)*2:trunc(ih*${ci.scale.toFixed(4)}/2)*2`
                );
                F.push(`[${i}:v]${vParts.join(',')}[vc${i}]`);
                const ox = Math.round(ci.posX * width);
                const oy = Math.round(ci.posY * height);
                F.push(`color=c=black:s=${width}x${height}:r=${fps}[bg${i}]`);
                F.push(`[bg${i}][vc${i}]overlay=x=(W-w)/2+${ox}:y=(H-h)/2+${oy}:shortest=1,fps=${fps},format=yuv420p,settb=AVTB${tailPad}[v${i}]`);
            }

            const clipMuted = videoTrackMuted || ci.muted || ci.volume === 0;
            if (ci.hasAudio && !clipMuted) {
                const aParts = [
                    `atrim=start=${ci.inP}:end=${ci.outP}`,
                    'asetpts=PTS-STARTPTS',
                ];
                if (ci.reverse) aParts.push('areverse');
                aParts.push(...buildAtempoChain(ci.speed));
                if (ci.volume !== 1) aParts.push(`volume=${ci.volume.toFixed(2)}`);
                aParts.push(
                    'aformat=sample_rates=44100:channel_layouts=stereo',
                    // 先补静音再精确截断：音频长度严格 = 片段有效时长（与视频对齐，防 A/V 时长漂移）
                    `apad=pad_dur=${(ci.dur + 1).toFixed(3)}`,
                    `atrim=0:${ci.dur.toFixed(3)}`,
                    'asetpts=PTS-STARTPTS'
                );
                F.push(`[${i}:a]${aParts.join(',')}[a${i}]`);
            } else {
                // 无音轨或已静音 → 等长静音
                F.push(`anullsrc=r=44100:cl=stereo,atrim=0:${ci.dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
            }
        });

        // 转场链（"无转场"用极短淡化 ≈ 硬切，统一管线）；ffmpeg 6.1 xfade 全部内置类型
        const XFADE_TYPES = new Set([
            'fade', 'fadeblack', 'fadewhite', 'fadegrays', 'fadefast', 'fadeslow',
            'dissolve', 'distance', 'pixelize', 'radial', 'hblur', 'zoomin',
            'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'wipetl', 'wipetr', 'wipebl', 'wipebr',
            'slideleft', 'slideright', 'slideup', 'slidedown',
            'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
            'circleopen', 'circleclose', 'circlecrop', 'rectcrop',
            'vertopen', 'vertclose', 'horzopen', 'horzclose',
            'diagtl', 'diagtr', 'diagbl', 'diagbr',
            'hlslice', 'hrslice', 'vuslice', 'vdslice',
            'squeezeh', 'squeezev',
            'hlwind', 'hrwind', 'vuwind', 'vdwind',
            'coverleft', 'coverright', 'coverup', 'coverdown',
            'revealleft', 'revealright', 'revealup', 'revealdown',
        ]);
        let vLabel = 'v0';
        let aLabel = 'a0';
        let chainLen = clipInfos[0].dur;
        for (let k = 1; k < n; k++) {
            const t = transitions[k - 1] || { type: 'none', duration: 0 };
            const type = XFADE_TYPES.has(t.type) ? t.type : 'fade';
            const td = tdList[k - 1];
            const offset = Math.max(0, chainLen - td);
            const nv = `vx${k}`;
            const na = `ax${k}`;
            F.push(`[${vLabel}][v${k}]xfade=transition=${type}:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[${nv}]`);
            F.push(`[${aLabel}][a${k}]acrossfade=d=${td.toFixed(3)}:c1=tri:c2=tri[${na}]`);
            vLabel = nv;
            aLabel = na;
            chainLen = chainLen + clipInfos[k].dur - td;
        }

        // 字幕烧录（drawtext + textfile，避免转义问题）
        // 每条字幕可携带独立 style（剪映式逐条样式）；s.style 优先于全局 subtitleStyle
        // 按最大宽度自动断行：CJK 字符宽≈字号、半角≈0.55 字号，逐字累计宽度插入换行
        const NO_LINE_HEAD = /[，。！？、：；…,.!?;:）)】」』”’%℃]/; // 标点禁则：这些字符不放行首
        const wrapByWidth = (text, maxPx, fontSize) => {
            const chW = (c) => /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\u3000-\u303F]/.test(c) ? fontSize : fontSize * 0.55;
            const lines = [];
            for (const manual of String(text).split('\n')) {
                let line = '';
                let w = 0;
                for (const ch of manual) {
                    const cw = chW(ch);
                    if (line && w + cw > maxPx && !NO_LINE_HEAD.test(ch)) {
                        // 拉丁文回退到最近空格断行，避免把单词切成两半
                        const sp = line.lastIndexOf(' ');
                        if (ch !== ' ' && sp > line.length * 0.4) {
                            const carry = line.slice(sp + 1) + ch;
                            lines.push(line.slice(0, sp));
                            line = carry;
                            w = 0;
                            for (const c of line) w += chW(c);
                        } else {
                            lines.push(line.trimEnd());
                            line = ch === ' ' ? '' : ch;
                            w = ch === ' ' ? 0 : cw;
                        }
                    } else { line += ch; w += cw; }
                }
                lines.push(line);
            }
            return lines.filter(l => l.trim()).join('\n');
        };
        const font = findSubtitleFont();
        let subIdx = 0;
        if (font && subtitles.length > 0) {
            const fontEsc = escapeFontPath(font);
            const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

            const chain = [];
            for (const s of subtitles) {
                const text = String(s.text || '').trim();
                const start = Number(s.start), end = Number(s.end);
                if (!text || !(end > start)) continue;

                // ---- 逐条样式解析（带默认值与校验）----
                const st = { ...(subtitleStyle || {}), ...(s.style || {}) };
                const fontScale = Math.min(0.15, Math.max(0.02, Number(st.fontScale) || 0.052));
                const fontSize = Math.max(12, Math.round(height * fontScale));
                const fontColor = isHex(st.color) ? st.color : 'white';
                const outlineColor = isHex(st.outlineColor) ? st.outlineColor : 'black';
                const withBox = st.background === true;
                const boxColor = isHex(st.backgroundColor) ? st.backgroundColor : 'black';
                const bgOp = Math.min(1, Math.max(0, st.bgOpacity != null ? Number(st.bgOpacity) : 0.85));
                const anim = ['fade', 'slideup', 'pop'].includes(st.anim) ? st.anim : 'none';
                // 自由位置：x/y 为 0~1 的画面比例（0.5,0.92 = 底部居中）
                const xFrac = Math.min(1, Math.max(0, st.x != null ? Number(st.x) : 0.5));
                const yFrac = Math.min(1, Math.max(0, st.y != null ? Number(st.y) : 0.92));
                // 最大宽度（画面宽度比例），超出自动换行（与前端预览一致）
                const maxWFrac = Math.min(1, Math.max(0.3, Number(st.maxW) || 0.9));
                const wrapped = wrapByWidth(text, width * maxWFrac, fontSize);

                const txtFile = path.join(tmpDir, `sub_${subIdx++}.txt`);
                fs.writeFileSync(txtFile, wrapped, 'utf-8');

                // 入场动画（drawtext 表达式实现）：淡入用 alpha 随时间变化；上滑额外让 y 从下方 0.6 字高处归位；
                // 弹入（缩放）drawtext 做不了，导出时退化为淡入（预览有完整弹入效果）
                const animDur = 0.35;
                let alphaOpt = '';
                let yExpr = `(h-text_h)*${yFrac.toFixed(4)}`;
                if (anim !== 'none') {
                    const s0 = start.toFixed(3);
                    alphaOpt = `alpha='clip((t-${s0})/${animDur},0,1)':`;
                    if (anim === 'slideup') {
                        yExpr = `(h-text_h)*${yFrac.toFixed(4)}+${Math.round(fontSize * 0.6)}*max(0,1-(t-${s0})/${animDur})`;
                    }
                }
                chain.push(
                    `drawtext=fontfile='${fontEsc}':textfile='${escapeFontPath(txtFile)}':` +
                    `fontsize=${fontSize}:fontcolor=${fontColor}:borderw=${Math.max(2, Math.round(fontSize / 12))}:bordercolor=${outlineColor}@0.9:` +
                    `text_align=C:line_spacing=${Math.round(fontSize * 0.25)}:` +
                    (withBox ? `box=1:boxcolor=${boxColor}@${bgOp.toFixed(2)}:boxborderw=${Math.round(fontSize / 3)}:` : '') +
                    alphaOpt +
                    `x=(w-text_w)*${xFrac.toFixed(4)}:y='${yExpr}':enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
                );
            }
            if (chain.length > 0) {
                F.push(`[${vLabel}]${chain.join(',')}[vsub]`);
                vLabel = 'vsub';
            }
        }

        // 贴纸 overlay（单帧 PNG，overlay 默认重复末帧，配合 enable 控制时段）
        stickerInfos.forEach((si, k) => {
            const inputIdx = stickerInputBase + k;
            const h = Math.max(24, Math.round(si.size * height));
            F.push(`[${inputIdx}:v]scale=-1:${h}[stk${k}]`);
            F.push(
                `[${vLabel}][stk${k}]overlay=x=(W-w)*${si.x.toFixed(4)}:y=(H-h)*${si.y.toFixed(4)}:` +
                `enable='between(t,${si.start.toFixed(3)},${si.end.toFixed(3)})'[vstk${k}]`
            );
            vLabel = `vstk${k}`;
        });

        // 配音/音乐混音（变速 → 淡入淡出 → 音量 → 延迟到位）
        const activeAudios = audioTrackMuted ? [] : audioInfos.filter(ai => ai.volume > 0);
        if (activeAudios.length > 0) {
            const ttsLabels = [];
            activeAudios.forEach((ai, j) => {
                const inputIdx = n + audioInfos.indexOf(ai);
                const delayMs = Math.round(ai.start * 1000);
                const effDur = (ai.outP - ai.inP) > 0 ? (ai.outP - ai.inP) / ai.speed : 0;
                const parts = [
                    `atrim=start=${ai.inP.toFixed(3)}:end=${ai.outP.toFixed(3)}`,
                    'asetpts=PTS-STARTPTS',
                    'aformat=sample_rates=44100:channel_layouts=stereo',
                ];
                parts.push(...buildAtempoChain(ai.speed));
                if (ai.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${ai.fadeIn.toFixed(2)}`);
                if (ai.fadeOut > 0 && effDur > ai.fadeOut) parts.push(`afade=t=out:st=${(effDur - ai.fadeOut).toFixed(2)}:d=${ai.fadeOut.toFixed(2)}`);
                if (ai.volume !== 1) parts.push(`volume=${ai.volume.toFixed(2)}`);
                parts.push(`adelay=${delayMs}|${delayMs}`);
                F.push(`[${inputIdx}:a]${parts.join(',')}[tts${j}]`);
                ttsLabels.push(`[tts${j}]`);
            });
            F.push(`[${aLabel}]${ttsLabels.join('')}amix=inputs=${1 + ttsLabels.length}:duration=first:normalize=0[aout]`);
            aLabel = 'aout';
        }

        // 最终统一像素格式（drawtext 可能升为 yuv444，转回 yuv420p 保证播放器兼容）
        F.push(`[${vLabel}]format=yuv420p[vfinal]`);
        vLabel = 'vfinal';

        // filtergraph 写入脚本文件（避免命令行长度/转义问题）
        const scriptPath = path.join(tmpDir, 'filter.txt');
        fs.writeFileSync(scriptPath, F.join(';\n'), 'utf-8');

        const outId = `vid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const outFile = path.join(VIDEOS_DIR, `${outId}.mp4`);

        const args = [
            '-y',
            ...inputs,
            '-filter_complex_script', scriptPath,
            '-map', `[${vLabel}]`,
            '-map', `[${aLabel}]`,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            outFile,
        ];

        console.log(`[VideoStudio] Export: ${n} clips, ${subtitles.length} subs, ${audioInfos.length} audios -> ${outId}.mp4`);
        await runFfmpeg(args, { timeoutMs: 1200000 });

        // 写入素材库元数据，让导出结果出现在「历史 / 素材」里
        const metadata = {
            id: outId,
            filename: `${outId}.mp4`,
            prompt: '视频剪辑导出',
            model: 'video-studio',
            createdAt: new Date().toISOString(),
            type: 'videos',
        };
        fs.writeFileSync(path.join(VIDEOS_DIR, `${outId}.json`), JSON.stringify(metadata, null, 2));

        res.json({ success: true, url: `/library/videos/${outId}.mp4` });
    } catch (error) {
        console.error('[VideoStudio] Export error:', error);
        res.status(500).json({ error: error.message || '导出失败' });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }
});

export default router;
