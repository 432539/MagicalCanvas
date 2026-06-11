/**
 * 一键创建工作流：小说/剧本 → 结构化分镜与资产数据
 *
 * 调用统一配置的文字模型（OpenAI 兼容 chat/completions），
 * 产出：风格锚定词 + 人物/场景/道具资产（含生图提示词）+ 分镜表（含图片/视频提示词、时长、资产引用）。
 * 前端据此自动创建画布节点与连线。
 */

import express from 'express';
import { getKey } from '../config.js';
import { gpt2apiChat } from '../services/gpt2api.js';

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

const SYSTEM_PROMPT = `你是资深的影视分镜师、美术指导与 AI 绘画提示词专家。用户会提供一段小说或剧本，你需要把它改编为可直接用于 AI 图像/视频生成的完整制作数据。

## 输出格式
只输出一个 JSON 对象，禁止输出任何其他文字、解释或 markdown 代码块。结构如下：
{
  "title": "作品标题（根据内容起名，6字以内）",
  "summary": "剧情概要（80字以内）",
  "styleAnchor": "统一的风格锚定词（用于保证全片画风一致，中英文关键词均可，逗号分隔，必须具体到渲染方式/质感/色调，禁止写实摄影与二次元混用）",
  "characters": [{ "name": "角色名", "desc": "中文视觉描述（性别开头，外貌/发型/服饰/体态/气质，40-80字）", "prompt": "英文生图提示词（逗号分隔关键词，以性别词开头如 a young man，包含发型/五官/服饰/气质，结尾加 full body, character design, standing pose, clean background）" }],
  "scenes": [{ "name": "场景名", "desc": "中文视觉描述（空间结构/光照氛围/关键陈设/色调，40-80字）", "prompt": "英文生图提示词（场景空镜，无人物，包含空间/陈设/氛围/色调，结尾加 establishing shot, no humans）" }],
  "props": [{ "name": "道具名", "desc": "中文视觉描述（30-60字）", "prompt": "英文生图提示词（道具特写，结尾加 item close-up, clean background）" }],
  "shots": [{
    "index": 1,
    "description": "中文画面描述：像导演讲戏一样具体——谁在哪做什么连续动作、景别（远/全/中/近/特写）、构图与人物朝向，禁止抽象情绪词",
    "characters": ["出现的角色名"],
    "scene": "所在场景名",
    "props": ["涉及的道具名，没有则空数组"],
    "imagePrompt": "该分镜的生图提示词：必须以 styleAnchor 开头，然后是场景关键词 + 角色完整外观关键词（直接复制该角色 prompt 中的核心外观词，保证一致性）+ 动作姿态 + 景别构图，最后加画质词",
    "videoPrompt": "视频生成提示词（中文）：描述镜头内的连续动态（人物动作变化、镜头运动如推/拉/摇/移/跟），1-3句话",
    "duration": 6,
    "dialogue": "该镜头台词原文（没有则空字符串）"
  }]
}

## 创作规则
1. 角色 ≤6 个、场景 ≤6 个、道具 ≤4 个，只提取有视觉意义的
2. 每个分镜的 imagePrompt 必须独立完整可用（不依赖上下文），其中角色外观关键词必须与该角色资产 prompt 中的描述逐词一致，这是保证人物一致性的关键
3. styleAnchor 必须出现在所有 characters/scenes/props/shots 的 prompt 开头
4. 分镜要覆盖故事的起承转合，动作具体可拍摄
5. 有台词的分镜 duration ≥ 台词字数÷4 + 1 秒；无台词镜头不超过用户指定时长
6. shots 数量遵守用户要求的上限`;

router.post('/analyze', async (req, res) => {
    try {
        const { script, shotDuration = 6, style = '', maxShots = 12, aspectRatio = '16:9' } = req.body || {};
        if (!script || !String(script).trim()) {
            return res.status(400).json({ error: '请输入小说或剧本内容' });
        }

        const apiKey = getKey('TEXT_API_KEY');
        if (!apiKey) {
            return res.status(400).json({ error: '请先在设置中配置文字模型 API Key' });
        }

        // 控制输入长度，避免超出上下文（过长截断并提示模型）
        const MAX_INPUT = 16000;
        let text = String(script);
        let truncated = false;
        if (text.length > MAX_INPUT) {
            text = text.slice(0, MAX_INPUT);
            truncated = true;
        }

        const shots = Math.max(3, Math.min(20, Number(maxShots) || 12));
        const dur = Math.max(3, Math.min(15, Number(shotDuration) || 6));

        const ratioDesc = aspectRatio === '9:16'
            ? '9:16 竖屏（适合短视频平台，构图以纵向为主：人物宜近景/中景，场景注意纵深与上下空间布局）'
            : '16:9 横屏（电影画幅，构图以横向为主：注意左右空间关系与宽幅场景调度）';

        const userMsg = [
            `【视频风格要求】${style || '由你根据故事题材决定最合适的风格'}`,
            `【画幅比例】${ratioDesc}，所有分镜的画面描述与生图提示词都要按此画幅构图`,
            `【单镜头基准时长】${dur} 秒（无台词镜头不超过此值）`,
            `【分镜数量】${shots} 个左右（不超过 ${shots + 2} 个）`,
            truncated ? '【注意】以下文本因过长被截断，请基于现有内容完成改编：' : '【小说/剧本原文】',
            text,
        ].join('\n\n');

        const reply = await gpt2apiChat({
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMsg },
            ],
            model: getKey('TEXT_MODEL') || 'grok-4.20-fast',
            baseUrl: getKey('TEXT_API_URL'),
            apiKey,
            temperature: 0.5,
            maxTokens: 16000,
        });

        const data = extractJson(reply);

        // 基本结构校验与兜底
        if (!Array.isArray(data.shots) || data.shots.length === 0) {
            throw new Error('AI 返回的分镜数据为空，请重试或缩短输入文本');
        }
        data.characters = Array.isArray(data.characters) ? data.characters : [];
        data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
        data.props = Array.isArray(data.props) ? data.props : [];
        data.styleAnchor = data.styleAnchor || style || '';
        data.shots.forEach((s, i) => {
            s.index = i + 1;
            s.duration = Math.max(2, Math.min(15, Number(s.duration) || dur));
            s.characters = Array.isArray(s.characters) ? s.characters : [];
            s.props = Array.isArray(s.props) ? s.props : [];
        });

        res.json(data);
    } catch (error) {
        console.error('[story-workflow] analyze error:', error);
        res.status(500).json({ error: error.message || '剧本分析失败' });
    }
});

export default router;
