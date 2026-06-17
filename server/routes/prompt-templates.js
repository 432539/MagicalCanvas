/**
 * prompt-templates.js
 *
 * 「一键创建工作流」的提示词模板系统。
 * 一套模板 = 三段式专业流水线的三段系统提示词 + 风格锚定词：
 *   - screenplayPrompt：小说 → 节拍化剧本（情绪外化、台词时长、开篇钩子/爽点/悬念）
 *   - assetPrompt：剧本 → 人物三视图 / 场景全景 / 道具特写（工业级统一规范）
 *   - storyboardPrompt：剧本 → 分镜（节奏自动判定镜头数、相邻景别差≥2、七要素融入视频提示词）
 *
 * 内置 4 套（不可删除），用户可在内置基础上编辑、导入文件、另存为自定义（落盘 library/prompt-templates/）。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// ============================================================================
// 三段式提示词构建（内置模板共用同一套专业骨架，风格相关部分参数化）
// ============================================================================

/** 第一段：小说 → 节拍化剧本（与视觉风格无关，所有模板共用） */
const SCREENPLAY_PROMPT = `你是顶级 AI 漫剧编剧，擅长把小说改编为高度视觉化、强节奏的分集剧本。核心目标：观众前 3 秒被吸引，全程有爽点，每段结尾留悬念。

## 改编铁律
1. 绝对禁止镜头术语（不得出现"特写/推拉摇移"等），镜头交给后续分镜环节。
2. 情绪外化：所有心理活动都用可见的动作、表情、环境细节呈现，禁止空洞形容词，用精准动词+名词。
3. 保留并优化台词：小说对话必须保留但要精简；独白/内心戏转为"自言自语"或"画外音"。
4. 台词时长↔字数约束（按预估语速 3 字/秒）：2秒≤6字、3秒≤9字、4秒≤12字、5秒≤15字；超 15 字必须拆分或精简。优先 3-4 秒节拍（9-12 字台词）。
5. 节拍合并：一个节拍可同时含"动作/表情 + 台词"，不要把动作和台词强行拆成两拍。
6. 连续性：相邻节拍要有视线/动作/位置/情绪的钩子，避免跳跃。

## 叙事节奏与钩子
- 开篇 3 拍：①反常画面或爆点台词 ②制造悬念/冲突 ③给出"不得不看"的理由。
- 爽点密度：每 10~20 拍一个爽点（打脸/金手指/反转/高光/情绪爆发）。
- 结尾 3 拍：①走向明朗或绝境 ②意外转折 ③抛钩子。
- 每集约 90 秒、30~45 个节拍，每拍必须有信息增量。

## 输出格式
直接输出剧本正文，不要任何解释。每场戏以"内景/外景 地点 - 时间"单独一行开头；每个叙事节拍用数字序号单独成行；台词写在动作描述之后，用 角色名说："台词"。不同场次之间空一行。`;

/** 第二段：剧本 → 资产（人物三视图 / 场景全景 / 道具特写），风格参数化，输出 JSON */
function buildAssetPrompt(styleName, styleAnchor) {
    return `你是专业的 AI 漫剧美术指导，擅长从剧本中提取人物、场景、道具，并产出可保证全片一致性的生图提示词。统一画风：【${styleName}】${styleAnchor}。

## 任务
从给定剧本中提取：主要人物（主角/反派/重要配角，≤6 个）、主要场景（出现 2 次以上或有重要剧情，≤6 个）、关键道具（推动剧情或反复出现，≤4 个）。只提取有视觉意义的。

## 人物（三视图设定图）规范
每个人物一张 16:9 设定图，从左到右：①面部特写 ②全身正面 ③全身侧面 ④全身背面。统一规范：纯白背景无阴影、中性无表情、标准站姿双手自然垂直、九头身比例、从头到脚不裁切、均匀柔光、8K 超高清无崩坏、无任何道具。提取维度：精确性别年龄、身高体型、脸型、眼睛/眉毛/鼻嘴、发型发色、肤色、全套服装配饰、特殊标记。prompt 必须以风格锚定词开头。

## 场景（全景图）规范
每个场景一张 16:9 平视全景，绝对无人物无生物、可多集复用、无文字。提取：精确位置、时间、天气、氛围、空间结构（形状尺寸/门窗/墙地天花）、核心家具与道具、光源与色调。prompt 以风格锚定词开头，结尾加 establishing shot, no humans。

## 道具（特写图）规范
每个道具一张 16:9 正面平视特写、占画面 80%、纯白背景无阴影、可复用。提取：名称用途、尺寸形状、配色材质、新旧状态、特殊标记。prompt 以风格锚定词开头，结尾加 item close-up, clean white background。

## 输出格式
只输出一个 JSON 对象，禁止任何解释或 markdown：
{
  "styleAnchor": "${styleAnchor}",
  "characters": [{ "name": "角色名", "desc": "中文视觉描述(性别开头,40-80字)", "prompt": "以风格锚定词开头的完整三视图生图提示词" }],
  "scenes": [{ "name": "场景名", "desc": "中文视觉描述(40-80字)", "prompt": "以风格锚定词开头的全景生图提示词" }],
  "props": [{ "name": "道具名", "desc": "中文视觉描述(30-60字)", "prompt": "以风格锚定词开头的道具特写生图提示词" }]
}`;
}

/** 第三段：剧本 + 资产 → 分镜（节奏自动镜数、景别差≥2、七要素融入 videoPrompt），输出 JSON */
function buildStoryboardPrompt(styleName, styleAnchor) {
    return `你是专业的 AI 漫剧分镜师，为 AI 视频生成设计分镜。统一画风：【${styleName}】${styleAnchor}。人物/场景/道具的外观由参考图保证，分镜里只用其"名字"，不重复描述外貌。

## 节奏自动判定（决定镜头数与时长）
根据每段剧情内容自动判定节奏类型并据此分配镜头：
- 快节奏高潮（争吵/打斗/追逐/情绪爆发/对峙；动作动词密集或强情绪词或短句感叹）：每镜 1-2 秒，镜头更密。
- 中速推进（走位/持续动作/多轮对话/环境展示）：每镜 2-3 秒。
- 平稳叙事（静态对话/注视沉思/细节/情绪铺垫）：每镜 3-5 秒。
混合时以主体情绪为准、宁快勿拖。

## 镜头语言规则
- 每个镜头七要素：景别 + 运镜 + 场景 + 主体站位朝向 + 主体动作 + 台词(无则省) + 音效(无则省)。
- 标准景别（由远到近）：大远景/远景/全景/中全景/中景/中近景/近景/特写/大特写。
- 相邻镜头景别差优先≥2，绝对禁止同景别硬切（如全景→全景）。
- 台词时长↔字数：1-5字≥1-2秒、6-10字≥2-3秒、11-20字≥3-4秒、21-30字≥4-5秒，不得把长台词压进 1-2 秒。

## 每个镜头的生成方法（keyframe，智能判断）
为每个镜头判断用"单帧"还是"首尾帧"生成，规则：
- single（单帧）：画面相对静态、平稳叙事、动作幅度小、无明显运动方向（如对话、注视、特写、情绪铺垫）。
- startend（首尾帧）：动作幅度大、有明确连续动作或运动方向、镜头内有明显位置/姿态变化、或与前后镜头有强动作连续性（如打斗、奔跑、转身、推门、挥手、镜头跟随）。
首尾帧镜头要保证 endImagePrompt 与 imagePrompt 同场景同角色，仅姿态/表情/位置变化（即动作的"开始"与"结束"两个瞬间）。

## 安全与合规（强制）
红线禁令：政治敏感、违法暴力血腥、涉黄涉赌毒、封建迷信、裸露性暗示自残等一律禁止；敏感桥段改用剪影/手部特写/空镜隐喻/背影/音效暗示。人物 100% 原创虚构，无真人/明星/公众人物特征与版权 IP。价值观正向。

## 每个分镜要产出
- imagePrompt：该分镜的生图提示词，必须以风格锚定词开头，然后场景关键词 + 出场角色名 + 动作姿态 + 景别构图 + 画质词，可直接用于文生图。
- videoPrompt：结构化视频提示词（中文，用 \\n 换行，把七要素和节奏写进去），固定小节：
【节奏】快节奏高潮/中速推进/平稳叙事
【景别运镜】景别 + 运镜方式（如 近景，缓慢推轨）
【场景】环境与空间一句话
【画面】按时长分 1-3 拍，每拍：起止秒 + 谁在画面什么位置朝向 + 做什么连续动作
【人物】每个出场角色一行：角色名：【表情】…【动作】…
【台词】角色名：（语气）"台词"；无则写 无
【音效】环境音/动作音；无则写 无
【氛围】光影/氛围一句话

## 输出格式
只输出一个 JSON 对象，禁止任何解释或 markdown：
{
  "title": "作品标题(6字以内)",
  "summary": "剧情概要(80字以内)",
  "shots": [{
    "index": 1,
    "keyframe": "single 或 startend（按上面的生成方法规则智能判断）",
    "shotSize": "景别(如 近景)",
    "description": "中文画面描述:谁在哪做什么连续动作+景别构图+人物朝向,禁止抽象情绪词",
    "characters": ["出场角色名"],
    "scene": "所在场景名",
    "props": ["涉及道具名,无则空数组"],
    "imagePrompt": "以风格锚定词开头的分镜首帧(镜头开始瞬间)生图提示词",
    "endImagePrompt": "以风格锚定词开头的分镜尾帧(镜头结束瞬间,动作完成后的画面,与首帧同场景同角色,仅姿态/表情/位置变化)生图提示词,用于首尾帧图生视频",
    "videoPrompt": "上述结构化七要素视频提示词",
    "duration": 4,
    "dialogue": "该镜头台词原文,无则空字符串"
  }]
}`;
}

/** 构造一套内置模板 */
function makeTemplate(id, name, styleName, styleAnchor, desc) {
    return {
        id,
        name,
        desc,
        builtin: true,
        styleAnchor,
        screenplayPrompt: SCREENPLAY_PROMPT,
        assetPrompt: buildAssetPrompt(styleName, styleAnchor),
        storyboardPrompt: buildStoryboardPrompt(styleName, styleAnchor),
    };
}

// ---- 4 套内置模板 ----
const BUILTIN_TEMPLATES = [
    makeTemplate(
        'builtin-general', '通用（自动判断）', '影视级',
        '电影级画质，统一画风，光影考究，色调统一，高细节',
        '不限定具体画风，由 AI 根据题材选择最合适的风格'
    ),
    makeTemplate(
        'builtin-guoman', '3D 国漫漫剧', '3D 国漫风',
        '3D 国漫风，次世代 3D 国漫质感，国风审美，8K HDR，PBR 物理材质，电影级镜头语言，禁止真人，禁止写实照片',
        '主流 AI 漫剧风格，适合古风/玄幻/都市短剧'
    ),
    makeTemplate(
        'builtin-cinematic', '写实电影短剧', '写实电影',
        '写实电影风格，photorealistic, cinematic lighting, 35mm film, 胶片质感，电影构图，高动态范围',
        '真人感写实短剧，强调电影质感与光影'
    ),
    makeTemplate(
        'builtin-xianxia', '国风修仙', '国风工笔/水墨',
        '国风修仙画风，工笔与水墨结合，仙气缭绕，飘逸服饰，唯美光效，电影级构图，8K 高清',
        '仙侠/修真题材，唯美东方美学'
    ),
];

// ============================================================================
// 自定义模板存储（落盘 LIBRARY_DIR/prompt-templates）
// ============================================================================

function tplDir(req) {
    const base = req.app.locals.LIBRARY_DIR || path.join(process.cwd(), 'library');
    const dir = path.join(base, 'prompt-templates');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function readCustom(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
            const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (t && t.id) out.push({ ...t, builtin: false });
        } catch { /* 跳过损坏文件 */ }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** GET / —— 列出全部模板（内置 + 自定义） */
router.get('/', (req, res) => {
    try {
        res.json([...BUILTIN_TEMPLATES, ...readCustom(tplDir(req))]);
    } catch (e) {
        res.status(500).json({ error: e.message || '读取模板失败' });
    }
});

/** POST / —— 新建或更新一个自定义模板 */
router.post('/', (req, res) => {
    try {
        const { id, name, desc, styleAnchor, screenplayPrompt, assetPrompt, storyboardPrompt } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写模板名称' });
        // 不允许覆盖内置模板 id
        let tid = id && !String(id).startsWith('builtin-') ? String(id) : `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const dir = tplDir(req);
        const existing = fs.existsSync(path.join(dir, `${tid}.json`))
            ? JSON.parse(fs.readFileSync(path.join(dir, `${tid}.json`), 'utf8')) : null;
        const tpl = {
            id: tid,
            name: String(name).slice(0, 40),
            desc: String(desc || '').slice(0, 120),
            builtin: false,
            styleAnchor: String(styleAnchor || ''),
            screenplayPrompt: String(screenplayPrompt || SCREENPLAY_PROMPT),
            assetPrompt: String(assetPrompt || ''),
            storyboardPrompt: String(storyboardPrompt || ''),
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };
        fs.writeFileSync(path.join(dir, `${tid}.json`), JSON.stringify(tpl, null, 2), 'utf8');
        res.json(tpl);
    } catch (e) {
        res.status(500).json({ error: e.message || '保存模板失败' });
    }
});

/** DELETE /:id —— 删除自定义模板（内置不可删） */
router.delete('/:id', (req, res) => {
    try {
        const id = req.params.id;
        if (String(id).startsWith('builtin-')) return res.status(400).json({ error: '内置模板不可删除' });
        const file = path.join(tplDir(req), `${id}.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message || '删除模板失败' });
    }
});

export { BUILTIN_TEMPLATES, SCREENPLAY_PROMPT, buildAssetPrompt, buildStoryboardPrompt };
export default router;
