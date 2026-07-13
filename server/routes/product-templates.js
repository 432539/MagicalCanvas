/**
 * 产品一键出片提示词模板。
 * 内置模板只存在于代码中；用户模板独立落盘到 library/product-templates。
 */
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();

const COMMON_COMPLIANCE = [
    '不得虚构检测、认证、销量、排名、价格、赠品或用户评价',
    '不得使用绝对化、保证性用语，不承诺疗效、收益或永久效果',
    '不得贬低竞品，不使用未经授权的商标、IP、明星或公众人物形象',
    '食品、美妆、医疗功效等敏感表述必须改为客观的外观、口感或使用感受描述',
];

const COMMON_DEFAULTS = {
    conceptCount: 3,
    shotsPerConcept: 8,
    aspectRatio: '9:16',
    videoDuration: 15,
    platform: '抖音',
};

function makeTemplate(id, industry, focus, styleAnchor, extraRules = [], defaults = {}) {
    const analyzePrompt = `你是拥有十年以上商业广告经验的${industry}产品策略师、视觉识别专家和电商合规审核员。

任务目标：从多张产品参考图与用户资料中建立可供广告创意、AI 生图和视频生成共同使用的“产品视觉 DNA”，最大限度保证后续所有镜头中的商品一致、卖点可信、表达合规。

专业分析框架：
1. 主体识别：判断各参考图是否为同一商品，区分产品本体、包装、配件、道具与背景，识别正面、侧面、背面及细节视角。
2. 视觉解剖：精确描述外轮廓、长宽比例、结构层级、主辅色及其分布、材质反射特征、表面纹理、包装开合方式、标签版式、Logo 与可辨认文字的位置。
3. 一致性锚点：生成一段可直接复用于每条生图和视频提示词的完整描述；必须包含不可改变的形态、颜色、材质、比例、标签位置和品牌辨识特征。
4. 卖点证据：把信息分为“图片可见”“用户明确提供”“待确认”三类。只有前两类可以进入广告卖点，不得把常识、联想或行业惯例当成事实。
5. 消费者洞察：基于已确认信息推导目标人群、使用情境、真实痛点、购买顾虑与画面可证明的利益点，避免空泛人群标签。
6. 风险审查：主动标记功效、参数、认证、销量、价格、优惠、产地、成分等需要额外证据的信息。

本行业重点：${focus}。

质量标准：描述必须具体、可视化、可执行，禁止使用“高级感、效果很好、品质优秀”等没有画面依据的空泛词。看不清、被遮挡或多图存在冲突的信息统一写“待确认”，绝不猜测。`;
    return {
        id,
        name: industry,
        desc: `${industry}产品广告创意与多镜头出片模板`,
        industry,
        builtin: true,
        analyzePrompt,
        dnaPrompt: analyzePrompt, // 前端编辑器使用的兼容别名
        conceptPrompt: `你是获得过头部品牌项目经验的${industry}短视频广告创意总监、文案策略师和平台内容导演。

任务目标：将产品视觉 DNA 转化为多套定位鲜明、能够实际拍摄或由生成模型稳定执行、具备完整说服链路的广告方案。

每套创意必须：
1. 采用不同的核心策略，不得只替换标题。可从痛点反转、场景代入、细节证据、使用过程、审美欲望、问题解答中选择最适合该商品的角度。
2. 明确唯一目标受众、一个核心利益点和一个购买顾虑，形成“钩子—冲突/需求—产品出场—证据展示—利益落点—行动号召”的闭环。
3. 前三秒钩子必须是可拍摄的具体画面或自然口语，避免“你绝对想不到”“震惊”等廉价标题党。
4. 脚本按成片总时长控制信息密度，旁白与字幕口语化、短句化；中文口播按每秒约 3.5～4 个汉字估算，给镜头动作和产品展示留出时间。
5. 卖点必须来自已确认信息，并优先设计“画面证据”而非口头宣称；不同创意之间的钩子、场景、视觉节奏和说服逻辑要显著不同。
6. 行动号召自然、具体、合规，不虚构促销、库存紧张、销量或用户口碑。
7. 为每套创意给出独立视觉导演矩阵：场景世界、色彩与灯光、道具策略、镜头节奏及与其他方案的差异。不同方案禁止复用同一背景、同一产品摆位和同一套镜头模板。

输出前进行内部检查：策略是否重复、钩子能否在画面中成立、脚本能否在规定时长说完、每个主张是否有证据、是否适配目标平台。`,
        shotPrompt: `你是${industry}商业广告导演、分镜师、摄影指导和生成式视频提示词工程师。

任务目标：把每套创意转化为前后连续、构图专业、商品一致、可直接用于 AI 生图并作为同一条视频多图参考的关键帧序列。

分镜设计标准：
1. 每个镜头明确叙事职责，并完整考虑景别、机位角度、镜头焦段感、构图、主体站位、动作、环境、光线、色彩、材质、运镜、节奏、旁白、字幕和转场。
2. 镜头序列遵循建立—强调—证明—收束的视觉语法；相邻镜头至少改变景别、角度或运动中的两项，避免连续重复“商品摆拍”。
3. imagePrompt 必须是可执行的中文静帧描述：先写产品一致性锚点，再写场景与主体关系、景别机位、构图、光线色温、材质细节、商业摄影质感和画幅留白。
4. videoPrompt 必须基于该静帧描述起始状态、主体动作、镜头运动、速度、时间顺序、结束状态和与下一镜头的连续关系；禁止同时安排互相冲突的运镜。
5. 每条提示词都要写明商品外形、包装、主色、材质、尺寸比例、Logo/标签位置保持参考图一致；商品始终清晰、完整、可识别，不得被手部或道具大面积遮挡。
6. 每条提示词末尾加入负面约束：禁止商品变形、包装漂移、颜色改变、文字乱码、Logo 重复、凭空增加配件、手指异常、主体融合、镜头抖动、闪烁跳变、过度锐化和廉价塑料感。
7. 字幕只保留一个信息重点，旁白必须与当前画面证据同步；转场写清匹配依据，如动作匹配、构图匹配、遮挡转场或音效切点。
8. 同一创意的关键帧要像一组完整广告分镜：场景和光线连续，但每帧必须有明显的景别、构图、动作与叙事推进；禁止只在相同背景中轻微旋转产品。
9. 全部关键帧最终会被排入一张与成片比例完全一致的高分辨率故事板母版，因此每帧描述必须遵守成片安全区，在缩略画格中仍有清晰主体、单一视觉重点和可辨认的动作，不堆叠过多微小元素。

全部使用专业、自然、具体的中文。不要堆砌互相矛盾的风格词，不要写无法被模型表现的抽象情绪，不得添加产品 DNA 未确认的功效、参数、认证、价格或优惠。`,
        styleAnchor,
        complianceRules: [...COMMON_COMPLIANCE, ...extraRules],
        defaults: { ...COMMON_DEFAULTS, ...defaults },
    };
}

const BUILTIN_PRODUCT_TEMPLATES = [
    makeTemplate(
        'builtin-general-commerce',
        '通用电商',
        '商品主体识别、核心利益点、使用前后场景和购买决策信息',
        '国际品牌商业产品摄影，真实物理材质与准确色彩，柔和大面积主光配合轮廓光和可控反射，背景简洁但有空间层次，50mm～85mm 产品摄影焦段感，主体边缘清晰、明暗层次完整、包装与品牌色统一，克制高级的电商视觉，不使用廉价炫光和过度锐化',
    ),
    makeTemplate(
        'builtin-beauty-skincare',
        '美妆护肤',
        '瓶器形态、膏体或质地、肤感联想、使用步骤和目标人群',
        '高端美妆品牌广告，柔和透亮的漫射主光、精致轮廓高光与干净渐变背景，85mm 人像及 100mm 微距焦段感，真实瓶器玻璃/金属/磨砂材质，膏体液体纹理细腻，肤色自然不过度磨皮，包装颜色、泵头结构、文字版式始终一致，整体洁净、克制、奢华',
        ['不得宣称治疗皮肤疾病、速效美白、祛斑或其他无法证实的医疗功效'],
        { videoDuration: 15 },
    ),
    makeTemplate(
        'builtin-food-beverage',
        '食品饮料',
        '包装规格、食材可见信息、色泽口感、食用时刻和新鲜感',
        '高品质食品饮料广告，侧逆暖光塑造食材体积与新鲜质感，50mm 标准视角结合 100mm 微距细节，真实液体流动、气泡、冷凝水、蒸汽和食材纹理，色泽诱人但不过饱和，桌面场景整洁可信，包装比例、封口结构、标签位置与品牌色始终一致',
        ['不得虚构配料、产地、营养、无添加、保健或疾病预防功效'],
    ),
    makeTemplate(
        'builtin-digital-appliance',
        '3C数码/家电',
        '工业设计、接口与部件、可见功能、操作流程、空间尺度和科技体验',
        '国际科技品牌发布片质感，低调冷色环境与精确条形轮廓光，35mm～85mm 电影镜头焦段感，金属、玻璃、塑料和屏幕反射符合真实物理规律，工业结构锐利而不过度锐化，空间尺度可信，机身尺寸、按键、接口、开孔和标识位置始终一致，避免科幻粒子滥用',
        ['参数、续航、性能、能效与防护等级只能使用用户明确提供的数据'],
        { aspectRatio: '16:9', videoDuration: 15 },
    ),
    makeTemplate(
        'builtin-fashion-bags',
        '服装鞋包',
        '版型轮廓、面料纹理、颜色五金、穿搭场景和细节工艺',
        '高端时尚品牌 Campaign 质感，自然窗光或大面积柔光塑造立体轮廓，35mm 环境人像结合 85mm 细节焦段感，面料垂坠、针脚、皮革纹理与五金反射真实，肤色和商品颜色准确，造型简洁有编辑感，款式版型、图案、扣件和细节工艺始终一致',
        ['不得虚构材质成分、产地、设计师联名或奢侈品牌关系'],
    ),
    makeTemplate(
        'builtin-local-store',
        '本地生活/门店',
        '门店环境、服务过程、到店动线、招牌项目和真实可感知体验',
        '高品质本地生活纪实广告，真实门店环境与自然人物互动，24mm～35mm 环境建立镜头结合 50mm 服务细节，现场光与柔和补光平衡，肤色自然、空间通透、烟火气真实，动作不过度表演，招牌、菜单、陈设、工服和门店视觉识别保持一致',
        ['地址、营业时间、价格、优惠、服务范围和预约条件只能使用用户提供的信息'],
        { conceptCount: 2, shotsPerConcept: 8, videoDuration: 15 },
    ),
];

function templateDir(req) {
    const base = req.app.locals.LIBRARY_DIR || path.join(process.cwd(), 'library');
    const dir = path.join(base, 'product-templates');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeId(value) {
    const id = String(value || '');
    return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : '';
}

function readCustomTemplates(dir) {
    return fs.readdirSync(dir)
        .filter(file => file.endsWith('.json'))
        .map(file => {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                return value?.id ? {
                    ...value,
                    analyzePrompt: value.analyzePrompt || value.dnaPrompt || '',
                    dnaPrompt: value.dnaPrompt || value.analyzePrompt || '',
                    builtin: false,
                } : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function allTemplates(req) {
    return [...BUILTIN_PRODUCT_TEMPLATES, ...readCustomTemplates(templateDir(req))];
}

function findProductTemplate(req, id, industry) {
    const templates = allTemplates(req);
    return templates.find(item => item.id === id)
        || templates.find(item => item.industry === industry)
        || BUILTIN_PRODUCT_TEMPLATES[0];
}

router.get('/', (req, res) => {
    try {
        res.json(allTemplates(req));
    } catch (error) {
        res.status(500).json({ error: error.message || '读取产品模板失败' });
    }
});

router.get('/:id', (req, res) => {
    try {
        const template = allTemplates(req).find(item => item.id === req.params.id);
        if (!template) return res.status(404).json({ error: '产品模板不存在' });
        res.json(template);
    } catch (error) {
        res.status(500).json({ error: error.message || '读取产品模板失败' });
    }
});

router.post('/', (req, res) => {
    try {
        const body = req.body || {};
        if (!String(body.name || body.industry || '').trim()) {
            return res.status(400).json({ error: '模板名称或行业不能为空' });
        }
        const requestedId = safeId(body.id);
        if (requestedId.startsWith('builtin-')) {
            return res.status(400).json({ error: '内置模板不可覆盖' });
        }
        const id = requestedId || `product_${crypto.randomUUID()}`;
        const file = path.join(templateDir(req), `${id}.json`);
        const existing = fs.existsSync(file)
            ? JSON.parse(fs.readFileSync(file, 'utf8'))
            : null;
        const now = new Date().toISOString();
        const template = {
            id,
            name: String(body.name || body.industry).trim().slice(0, 60),
            desc: String(body.desc || '自定义产品广告模板').trim().slice(0, 160),
            industry: String(body.industry || body.name).trim().slice(0, 60),
            builtin: false,
            analyzePrompt: String(body.analyzePrompt || body.dnaPrompt || ''),
            dnaPrompt: String(body.dnaPrompt || body.analyzePrompt || ''),
            conceptPrompt: String(body.conceptPrompt || ''),
            shotPrompt: String(body.shotPrompt || ''),
            styleAnchor: String(body.styleAnchor || ''),
            complianceRules: Array.isArray(body.complianceRules)
                ? body.complianceRules.map(String).map(v => v.trim()).filter(Boolean).slice(0, 30)
                : [],
            defaults: body.defaults && typeof body.defaults === 'object' ? body.defaults : {},
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };
        fs.writeFileSync(file, JSON.stringify(template, null, 2), 'utf8');
        res.json(template);
    } catch (error) {
        res.status(500).json({ error: error.message || '保存产品模板失败' });
    }
});

router.delete('/:id', (req, res) => {
    try {
        if (String(req.params.id).startsWith('builtin-')) {
            return res.status(400).json({ error: '内置模板不可删除' });
        }
        const id = safeId(req.params.id);
        if (!id) return res.status(400).json({ error: '模板 ID 无效' });
        const file = path.join(templateDir(req), `${id}.json`);
        if (!fs.existsSync(file)) return res.status(404).json({ error: '产品模板不存在' });
        fs.unlinkSync(file);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '删除产品模板失败' });
    }
});

export { BUILTIN_PRODUCT_TEMPLATES, findProductTemplate };
export default router;
