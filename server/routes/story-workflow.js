/**
 * 一键创建工作流（三段式专业流水线）：小说/剧本 → 节拍剧本 → 资产 → 分镜
 *
 * 三段各用一套系统提示词（来自所选「提示词模板」，可被前端覆盖）：
 *   ① screenplay：小说 → 节拍化剧本（情绪外化、台词时长、开篇钩子/爽点/悬念）
 *   ② asset：剧本 → 人物三视图 / 场景全景 / 道具特写（输出 JSON）
 *   ③ storyboard：剧本 + 资产 → 分镜（节奏自动镜数、景别差≥2、七要素融入 videoPrompt，输出 JSON）
 *
 * 全程 SSE 推送阶段进度。最终产出与旧版相同的数据结构，前端建节点逻辑无需改动。
 */

import express from 'express';
import { getKey } from '../config.js';
import { gpt2apiChat } from '../services/gpt2api.js';
import { BUILTIN_TEMPLATES, SCREENPLAY_PROMPT, buildAssetPrompt, buildStoryboardPrompt } from './prompt-templates.js';
import { analyzeScreenplayQuality } from '../utils/screenplay-quality.js';

const router = express.Router();

/** 从 LLM 回复中稳健地提取 JSON（容忍 markdown 代码块、前后废话） */
function extractJson(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('AI 未返回有效 JSON');
    return JSON.parse(t.slice(start, end + 1));
}

/** 调用文字模型（带瞬时错误自动重试 + 进度回调） */
async function callModel({ system, user, maxTokens, temperature, send, stage, onChars }) {
    const apiKey = getKey('TEXT_API_KEY');
    const model = getKey('TEXT_MODEL') || 'grok-4.20-fast';
    const baseUrl = getKey('TEXT_API_URL');
    const MAX_RETRY = 4;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            if (attempt > 0) send?.({ type: 'status', message: `${stage}：上游繁忙，第 ${attempt}/${MAX_RETRY} 次重试…` });
            let lastPush = 0;
            const reply = await gpt2apiChat({
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                model, baseUrl, apiKey, temperature: temperature ?? 0.6, maxTokens,
                onDelta: (_d, total) => {
                    if (total - lastPush >= 300 || lastPush === 0) {
                        lastPush = total;
                        onChars?.(total);
                    }
                },
            });
            if (reply && reply.trim()) return reply;
            throw new Error('AI 返回内容为空');
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || '');
            console.warn(`[story-workflow] ${stage} attempt ${attempt + 1} failed:`, msg);
            // 上游中转站对推理模型偶发：限流 / 暂不可用 / 路由到无权分组(Codex 分组) / 网关错误，均重试
            if (!/unavailable|temporarily|rate|limit|429|500|502|503|504|timeout|超时|为空|无权|权限|permission|denied|codex|分组|busy/i.test(msg)) throw e;
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
        }
    }
    throw lastErr || new Error(`${stage}失败`);
}

router.post('/analyze', async (req, res) => {
    const {
        script, shotDuration = 6, style = '', maxShots = 12, aspectRatio = '16:9',
        prompts = null, styleAnchor: styleAnchorIn = '',
    } = req.body || {};

    if (!script || !String(script).trim()) {
        return res.status(400).json({ error: '请输入小说或剧本内容' });
    }
    if (!getKey('TEXT_API_KEY')) {
        return res.status(400).json({ error: '请先在设置中配置文字模型 API Key' });
    }

    // 三段提示词：优先用前端传入（所选模板/已编辑），否则回退内置「通用」模板
    const fallback = BUILTIN_TEMPLATES[0];
    const styleAnchor = (styleAnchorIn || style || fallback.styleAnchor || '').trim();
    const screenplaySys = (prompts?.screenplay || SCREENPLAY_PROMPT);
    const assetSys = (prompts?.asset || buildAssetPrompt('影视级', styleAnchor));
    const storyboardSys = (prompts?.storyboard || buildStoryboardPrompt('影视级', styleAnchor));

    // SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端可能已断开 */ } };

    try {
        const MAX_INPUT = 16000;
        let text = String(script);
        let truncated = false;
        if (text.length > MAX_INPUT) { text = text.slice(0, MAX_INPUT); truncated = true; }

        const dur = Math.max(3, Math.min(15, Number(shotDuration) || 6));
        const isAuto = maxShots === 'auto' || maxShots === 'Auto';
        const shots = isAuto ? null : Math.max(3, Math.min(60, Number(maxShots) || 12));
        const ratioDesc = aspectRatio === '9:16'
            ? '9:16 竖屏（短视频构图，纵向为主：人物宜近景/中景）'
            : '16:9 横屏（电影画幅，横向为主：注意左右空间调度）';

        // ===== 第 1 段：小说 → 节拍剧本 =====
        send({ type: 'status', message: '第 1/3 步：正在改编为节拍剧本…' });
        const screenplayUser = [
            `【画幅】${ratioDesc}`,
            `【单镜头基准时长】${dur} 秒`,
            `【对话要求】改编后至少 40% 节拍含角色对白；原文对话场景必须保留核心台词；同场 A→B→A 对话要在相邻节拍连续，禁止跳接`,
            truncated ? '【注意】以下文本过长已截断，请基于现有内容改编：' : '【小说/剧本原文】',
            text,
        ].join('\n\n');
        const screenplay = await callModel({
            system: screenplaySys, user: screenplayUser, maxTokens: 12000, temperature: 0.7,
            send, stage: '改编剧本', onChars: (c) => send({ type: 'progress', stage: 1, chars: c }),
        });

        // ===== 第 2 段：剧本 → 资产（人物/场景/道具） =====
        send({ type: 'status', message: '第 2/3 步：正在提取人物、场景、道具…' });
        const assetUser = `统一风格锚定词：${styleAnchor}\n画幅：${aspectRatio}\n\n【剧本】\n${screenplay}`;
        const assetReply = await callModel({
            system: assetSys, user: assetUser, maxTokens: 12000, temperature: 0.5,
            send, stage: '提取资产', onChars: (c) => send({ type: 'progress', stage: 2, chars: c }),
        });
        const assetData = extractJson(assetReply);

        // ===== 第 3 段：剧本 + 资产 → 分镜 =====
        send({ type: 'status', message: '第 3/3 步：正在按节奏生成分镜…' });
        const charNames = (assetData.characters || []).map(c => c.name).filter(Boolean);
        const sceneNames = (assetData.scenes || []).map(s => s.name).filter(Boolean);
        const propNames = (assetData.props || []).map(p => p.name).filter(Boolean);
        const shotCountReq = isAuto
            ? '【镜头数量】由你根据剧情节奏自动决定总镜头数（覆盖起承转合，一般 8~45 个，快节奏处镜头更密）'
            : `【镜头数量】总镜头数约 ${shots} 个（不超过 ${shots + 3} 个）`;
        const storyboardUser = [
            `统一风格锚定词：${styleAnchor}`,
            `画幅：${ratioDesc}`,
            `单镜头基准时长：${dur} 秒（每个镜头 duration 默认填 ${dur}；绝对不要用 1-2 秒碎时长）`,
            `内容密度：每个镜头要装下约 ${dur} 秒的内容——把同一场景连续发生的多个节拍/多句台词合并进同一镜头来填满时长，不要每句台词就切一个镜头${dur >= 8 ? `（${dur} 秒的镜头通常应包含连续 2-3 句对白或一段完整动作）` : ''}`,
            shotCountReq,
            `可用人物：${charNames.join('、') || '无'}`,
            `可用场景：${sceneNames.join('、') || '无'}`,
            `可用道具：${propNames.join('、') || '无'}`,
            `\n【剧本】\n${screenplay}`,
        ].join('\n');
        const storyboardReply = await callModel({
            system: storyboardSys, user: storyboardUser, maxTokens: 28000, temperature: 0.5,
            send, stage: '生成分镜', onChars: (c) => send({ type: 'progress', stage: 3, chars: c }),
        });
        const sbData = extractJson(storyboardReply);

        // ===== 合并 + 兜底校验 =====
        send({ type: 'status', message: '正在整理分镜数据…' });
        if (!Array.isArray(sbData.shots) || sbData.shots.length === 0) {
            throw new Error('AI 返回的分镜数据为空，请重试或缩短输入');
        }
        const data = {
            title: sbData.title || assetData.title || '未命名',
            summary: sbData.summary || '',
            styleAnchor: assetData.styleAnchor || styleAnchor,
            characters: Array.isArray(assetData.characters) ? assetData.characters : [],
            scenes: Array.isArray(assetData.scenes) ? assetData.scenes : [],
            props: Array.isArray(assetData.props) ? assetData.props : [],
            shots: sbData.shots,
            screenplay, // 附带剧本全文，前端可写入剧本节点
        };
        data.shots.forEach((s, i) => {
            s.index = i + 1;
            // 时长严格以用户选择的基准时长为准；仅当台词较长时按字数(约每秒3字)加长，避免 AI 自定义碎时长
            const dlgLen = String(s.dialogue || '').replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '').length;
            const dlgMin = dlgLen > 0 ? Math.ceil(dlgLen / 3) + 1 : 0;
            s.duration = Math.min(15, Math.max(dur, dlgMin));
            s.characters = Array.isArray(s.characters) ? s.characters : [];
            s.props = Array.isArray(s.props) ? s.props : [];
        });

        const quality = analyzeScreenplayQuality({
            screenplay,
            shots: data.shots,
            sourceScript: text,
        });
        if (quality.warnings.length) {
            console.warn('[story-workflow] quality:', quality.summary, quality.warnings);
        }
        data.quality = quality;

        send({ type: 'done', data });
        res.end();
    } catch (error) {
        console.error('[story-workflow] analyze error:', error);
        send({ type: 'error', error: error.message || '剧本分析失败' });
        res.end();
    }
});

export default router;
