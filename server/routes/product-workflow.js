/**
 * 产品一键出片：商品图 → 产品 DNA → 多创意 → 每创意多镜头。
 */
import express from 'express';
import { jsonrepair } from 'jsonrepair';
import { getKey } from '../config.js';
import { multimodalChat, textChat } from '../utils/multimodal-chat.js';
import { BUILTIN_PRODUCT_TEMPLATES, findProductTemplate } from './product-templates.js';

const router = express.Router();

const DEFAULT_TEMPLATE = BUILTIN_PRODUCT_TEMPLATES[0];
const HAN = /[\u3400-\u9fff]/;

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function cleanString(value, fallback = '', max = 4000) {
    const text = typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    return (text || fallback).slice(0, max);
}

function cleanList(value, max = 20) {
    const list = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(/[\n,，;；]+/) : []);
    return list.map(item => cleanString(item, '', 300)).filter(Boolean).slice(0, max);
}

/** 容忍 markdown 围栏与前后说明，但最终必须是合法 JSON。 */
function parseStructuredJson(reply, stage) {
    let text = String(reply || '').trim().replace(/^\uFEFF/, '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const objectStart = text.indexOf('{');
    const arrayStart = text.indexOf('[');
    const starts = [objectStart, arrayStart].filter(index => index >= 0);
    if (!starts.length) throw new Error(`${stage}未返回 JSON`);
    const start = Math.min(...starts);
    const open = text[start];
    const end = open === '{' ? text.lastIndexOf('}') : text.lastIndexOf(']');
    if (end <= start) throw new Error(`${stage}返回的 JSON 不完整`);
    const candidate = text.slice(start, end + 1);
    try {
        return JSON.parse(candidate);
    } catch (strictError) {
        try {
            // 模型偶尔会输出缺逗号、中文引号、尾逗号或未转义引号；
            // jsonrepair 在不重新调用模型的情况下修复这些常见格式问题。
            return JSON.parse(jsonrepair(candidate));
        } catch (repairError) {
            throw new Error(`${stage}返回的 JSON 无法解析：${strictError.message}；自动修复失败：${repairError.message}`);
        }
    }
}

function normalizeProductDNA(raw, input) {
    const source = raw?.productDNA && typeof raw.productDNA === 'object' ? raw.productDNA : raw;
    const visual = source?.visualIdentity && typeof source.visualIdentity === 'object'
        ? source.visualIdentity
        : {};
    return {
        productName: cleanString(source?.productName, input.productName || '未命名商品', 100),
        category: cleanString(source?.category, '待确认', 100),
        visualIdentity: {
            shape: cleanString(visual.shape || source?.shape, '以商品参考图为准', 300),
            colors: cleanList(visual.colors || source?.colors, 8),
            materials: cleanList(visual.materials || source?.materials, 8),
            packaging: cleanString(visual.packaging || source?.packaging, '保持参考图包装结构、比例和标识一致', 500),
            visibleText: cleanList(visual.visibleText || source?.visibleText, 12),
            consistencyAnchor: cleanString(
                visual.consistencyAnchor || source?.consistencyAnchor,
                `${input.productName || '商品'}，外观、包装、主色、材质、比例和可见标识严格以参考图为准`,
                800,
            ),
        },
        confirmedSellingPoints: cleanList(source?.confirmedSellingPoints || source?.sellingPoints || input.sellingPoints, 12),
        targetAudience: cleanList(source?.targetAudience, 8),
        usageScenarios: cleanList(source?.usageScenarios, 10),
        uncertainties: cleanList(source?.uncertainties, 12),
        complianceRisks: cleanList(source?.complianceRisks, 12),
    };
}

function fallbackConcept(index, input) {
    const angles = ['痛点切入', '场景体验', '细节证明', '反差展示', '生活方式', '口碑问答'];
    const worlds = ['极简高级棚拍', '真实生活方式空间', '电影感功能演示', '自然户外体验', '编辑感时尚场景', '专业测评桌面'];
    const palettes = ['品牌主色与低饱和中性色', '自然暖光与生活化色彩', '冷调轮廓光与精密高光', '晨昏自然光与清透色彩', '高反差编辑光与克制点色', '均匀测评光与真实材质色'];
    const angle = angles[index % angles.length];
    return {
        id: `concept-${index + 1}`,
        title: `${angle}创意`,
        hook: `先展示与${input.productName || '这款商品'}相关的真实使用痛点`,
        angle,
        script: `从真实场景切入，展示商品外观和已确认卖点，再给出清晰的使用建议。`,
        cta: '根据实际需求了解商品详情',
        visualDirection: `${worlds[index % worlds.length]}；${palettes[index % palettes.length]}；以产品为唯一视觉主角`,
        sceneWorld: worlds[index % worlds.length],
        colorLighting: palettes[index % palettes.length],
        propStrategy: '只使用能解释场景或强化比例关系的少量道具，禁止无意义装饰',
        rhythm: index % 2 === 0 ? '强视觉钩子—完整亮相—细节证据—使用动作—品牌收束' : '情境建立—需求出现—产品介入—体验变化—行动号召',
        differentiation: `采用独立的${angle}叙事、布景、光线和镜头节奏`,
    };
}

function normalizeConcepts(raw, count, input) {
    const candidates = Array.isArray(raw) ? raw : (Array.isArray(raw?.concepts) ? raw.concepts : []);
    const concepts = [];
    for (let index = 0; index < count; index++) {
        const fallback = fallbackConcept(index, input);
        const item = candidates[index] && typeof candidates[index] === 'object' ? candidates[index] : {};
        concepts.push({
            id: cleanString(item.id, fallback.id, 80).replace(/[^a-zA-Z0-9_-]/g, '-') || fallback.id,
            title: cleanString(item.title, fallback.title, 100),
            hook: cleanString(item.hook, fallback.hook, 500),
            angle: cleanString(item.angle, fallback.angle, 300),
            script: cleanString(item.script, fallback.script, 2000),
            cta: cleanString(item.cta, fallback.cta, 300),
            visualDirection: cleanString(item.visualDirection, fallback.visualDirection, 1200),
            sceneWorld: cleanString(item.sceneWorld, fallback.sceneWorld, 500),
            colorLighting: cleanString(item.colorLighting, fallback.colorLighting, 500),
            propStrategy: cleanString(item.propStrategy, fallback.propStrategy, 500),
            rhythm: cleanString(item.rhythm, fallback.rhythm, 500),
            differentiation: cleanString(item.differentiation, fallback.differentiation, 500),
        });
    }
    // 防止模型返回重复 ID。
    concepts.forEach((concept, index) => {
        if (concepts.findIndex(item => item.id === concept.id) !== index) concept.id = `concept-${index + 1}`;
    });
    return concepts;
}

function durationForShot(videoDuration, index) {
    const startSec = index * 2;
    return Math.max(1, Math.min(2, videoDuration - startSec));
}

function fallbackShot(concept, index, options) {
    const phases = ['强钩子与痛点场景', '商品完整亮相', '核心卖点细节', '真实使用过程', '体验结果与行动号召'];
    const phase = phases[Math.min(index, phases.length - 1)];
    const anchor = options.consistencyAnchor;
    const negative = '负面约束：禁止商品变形、包装漂移、颜色改变、文字乱码、Logo重复、凭空增加部件、手指异常、主体融合、闪烁跳变、镜头抖动、过度锐化和廉价塑料感';
    const startSec = index * 2;
    const endSec = Math.min(options.videoDuration, startSec + 2);
    const beatDuration = Math.max(1, endSec - startSec);
    const script = cleanString(concept.script, '', 2000).replace(/\s+/g, '');
    const startChar = Math.floor(script.length * startSec / options.videoDuration);
    const endChar = Math.max(startChar + 1, Math.floor(script.length * endSec / options.videoDuration));
    const voiceover = script.slice(startChar, endChar).slice(0, Math.ceil(beatDuration * 4));
    return {
        index: index + 1,
        startSec,
        endSec,
        shotPurpose: phase,
        scene: options.sceneWorld || concept.sceneWorld || '与本创意视觉世界一致的商业场景',
        shotSize: index === 0 ? '环境中景建立' : (index === options.shotsPerConcept - 1 ? '产品英雄近景' : '产品细节特写'),
        camera: index === 0 ? '平视稳定机位' : '轻微侧前方电影机位',
        composition: '产品位于视觉焦点，空间层次清晰，保留安全字幕区',
        action: phase,
        imagePrompt: `${anchor}。镜头职责：${phase}。${options.styleAnchor}。${options.aspectRatio}画幅，专业商业广告构图，主体清晰完整，画面保留字幕安全区，真实光影与物理材质，细节锐利自然。${negative}`,
        videoPrompt: `${anchor}。以当前静帧为起始状态，围绕“${phase}”设计单一明确的主体动作和稳定电影感运镜，动作起止完整、节奏自然、物理运动可信，商品外观、包装、颜色、材质、尺寸比例、标签位置和可见标识全程不变，结尾构图为下一镜头保留连续性。${negative}`,
        duration: beatDuration,
        subtitle: index === 0 ? concept.hook : (index === options.shotsPerConcept - 1 ? concept.cta : concept.angle),
        voiceover,
        transition: index === options.shotsPerConcept - 1 ? '自然收束' : '动作匹配转场',
    };
}

function normalizeShots(raw, concepts, options) {
    const groups = Array.isArray(raw) ? raw : (Array.isArray(raw?.concepts) ? raw.concepts : []);
    const looseShots = Array.isArray(raw?.shots) ? raw.shots : [];
    return concepts.map((concept, conceptIndex) => {
        const group = groups.find(item => item?.id === concept.id)
            || groups[conceptIndex]
            || {};
        const candidates = Array.isArray(group?.shots)
            ? group.shots
            : (concepts.length === 1 ? looseShots : []);
        const shots = [];
        for (let shotIndex = 0; shotIndex < options.shotsPerConcept; shotIndex++) {
            const fallback = fallbackShot(concept, shotIndex, options);
            const item = candidates[shotIndex] && typeof candidates[shotIndex] === 'object'
                ? candidates[shotIndex]
                : {};
            let imagePrompt = cleanString(item.imagePrompt, fallback.imagePrompt, 2500);
            let videoPrompt = cleanString(item.videoPrompt, fallback.videoPrompt, 3000);
            if (!HAN.test(imagePrompt)) imagePrompt = `中文广告画面：${imagePrompt}`;
            if (!HAN.test(videoPrompt)) videoPrompt = `中文视频镜头：${videoPrompt}`;
            // 无论模型是否主动遵守，都把视觉一致性锚点写入每一个生成提示词。
            if (!imagePrompt.includes(options.consistencyAnchor)) {
                imagePrompt = `${options.styleAnchor}，${options.consistencyAnchor}。${imagePrompt}`;
            }
            if (concept.visualDirection && !imagePrompt.includes(concept.visualDirection)) {
                imagePrompt = `本创意独立视觉导演方案：${concept.visualDirection}。场景世界：${concept.sceneWorld}。色彩灯光：${concept.colorLighting}。${imagePrompt}`;
            }
            if (!videoPrompt.includes(options.consistencyAnchor)) {
                videoPrompt = `${options.consistencyAnchor}。${videoPrompt}`;
            }
            const startSec = shotIndex * 2;
            const endSec = Math.min(options.videoDuration, startSec + 2);
            const beatDuration = durationForShot(options.videoDuration, shotIndex);
            const maxVoiceChars = Math.max(4, Math.ceil(beatDuration * 4));
            shots.push({
                index: shotIndex + 1,
                startSec,
                endSec,
                shotPurpose: cleanString(item.shotPurpose, fallback.shotPurpose, 300),
                scene: cleanString(item.scene, fallback.scene, 500),
                shotSize: cleanString(item.shotSize, fallback.shotSize, 200),
                camera: cleanString(item.camera, fallback.camera, 300),
                composition: cleanString(item.composition, fallback.composition, 400),
                action: cleanString(item.action, fallback.action, 500),
                imagePrompt,
                videoPrompt,
                duration: beatDuration,
                subtitle: cleanString(item.subtitle, fallback.subtitle, 12),
                voiceover: cleanString(item.voiceover, fallback.voiceover, maxVoiceChars),
                transition: cleanString(item.transition, fallback.transition, 100),
            });
        }
        return { ...concept, shots };
    });
}

function promptValue(prompts, shortName, longName, fallback) {
    return cleanString(prompts?.[shortName] || prompts?.[longName], fallback, 20000);
}

function buildStoryboardBoardPrompt(concept, { videoDuration, aspectRatio, industry, productName, consistencyAnchor }) {
    const shots = Array.isArray(concept.shots) ? concept.shots : [];
    const count = shots.length;
    const portrait = aspectRatio === '9:16' || aspectRatio === '3:4';
    const square = aspectRatio === '1:1';
    const grid = count <= 3
        ? (portrait ? `纵向 ${count} 格` : `单排 ${count} 格`)
        : count <= 5
            ? (portrait ? '上排 2 格、中排 2 格、下排 1 格居中' : '上排 3 格、下排 2 格居中')
            : portrait || square
                ? '上排 3 格、中排 3 格、下排 2 格居中'
                : '上排 4 格、下排 4 格';
    const boardResolution = count >= 8 ? '4K 超高清' : '2K 高清';
    const panelDetails = shots.map((shot, index) => [
        `镜头${String(index + 1).padStart(2, '0')} ${shot.startSec}-${shot.endSec}秒`,
        `景别与机位：${shot.shotSize || '专业广告景别'}，${shot.camera || '稳定电影机位'}`,
        `场景：${shot.scene || concept.sceneWorld || '商业广告场景'}`,
        `构图：${shot.composition || '产品为视觉焦点'}`,
        `动作：${shot.action || shot.shotPurpose || '自然产品动作'}`,
        `画面：${shot.imagePrompt || ''}`,
        `下方短注：${shot.shotSize || '镜头'}｜${shot.shotPurpose || '产品展示'}｜${shot.subtitle || ''}`,
    ].join('；')).join('\n');

    return cleanString(`生成一张专业商业广告故事板母版大图。只生成一张 ${boardResolution}、${aspectRatio} 画幅故事板拼版，母版方向和最终成片完全一致，不是单帧海报，不要输出多张图片。

顶部使用克制、清晰的信息栏，标注：标题《${concept.title || productName}》｜行业：${industry}｜时长：${videoDuration}秒｜分镜数：${count}｜成片比例：${aspectRatio}｜视觉方向：${concept.visualDirection || ''}。

主体区域采用${grid}的严格网格，必须恰好包含 ${count} 个独立画格，不得为了填满网格增加空白镜头或第 ${count + 1} 格。每格都以 ${aspectRatio} 最终成片的安全区、主体大小和视觉重心进行构图，边框、间距、编号位置完全统一。镜号从镜头01连续到镜头${String(count).padStart(2, '0')}，不得重复、跳号或漏号；左上角只写镜号和数字时间码，画面下方只写一行极短简体中文注释。文字区域不得遮挡产品和人物。

产品高保真锁定：${consistencyAnchor}。所有出现产品的画格必须是同一个真实产品，包装结构、颜色、材质、长宽比例、杯盖/接口/五金、Logo及可见文字位置完全一致；严禁变形、改色、复制出多个产品、增加不存在的部件或复杂图案。

同一创意视觉统一：${concept.visualDirection || ''}。场景世界：${concept.sceneWorld || ''}。色彩与灯光：${concept.colorLighting || ''}。道具策略：${concept.propStrategy || ''}。关键帧之间必须有明显叙事推进，禁止只在同一背景轻微旋转产品。

逐格内容：
${panelDetails}

整体质量：国际广告公司客户提案级 storyboard board，真实商业摄影，电影级自然光和产品布光，材质准确，人物统一，构图专业，画面丰富但克制。全部文字使用中国大陆规范简体中文，宁可少写也不要乱码、繁体字、错字或无意义字符。故事板之外不要添加说明、装饰边框、水印或额外画格。`, '', 24000);
}

router.post('/analyze', async (req, res) => {
    const body = req.body || {};
    const productImageUrls = Array.from(new Set([
        ...(Array.isArray(body.productImageUrls) ? body.productImageUrls : []),
        body.productImageUrl,
    ].map(value => cleanString(value, '', 20_000_000)).filter(Boolean))).slice(0, 6);
    if (!productImageUrls.length) {
        return res.status(400).json({ error: '请至少提供一张产品参考图' });
    }
    if (!getKey('TEXT_API_KEY')) {
        return res.status(400).json({ error: '请先在设置中配置文字模型 API Key' });
    }

    const template = findProductTemplate(req, body.templateId, body.industry) || DEFAULT_TEMPLATE;
    const templateDefaults = template.defaults || {};
    const conceptCount = clampInt(body.conceptCount, 1, 8, templateDefaults.conceptCount || 3);
    const videoDuration = [6, 10, 15].includes(Number(body.videoDuration))
        ? Number(body.videoDuration)
        : ([6, 10, 15].includes(Number(templateDefaults.videoDuration)) ? Number(templateDefaults.videoDuration) : 15);
    const shotsPerConcept = Math.ceil(videoDuration / 2);
    const timelineSpec = Array.from({ length: shotsPerConcept }, (_, index) => {
        const start = index * 2;
        const end = Math.min(videoDuration, start + 2);
        return `关键帧${index + 1}=${start}-${end}秒`;
    }).join('；');
    const aspectRatio = ['9:16', '16:9', '1:1', '4:3', '3:4'].includes(body.aspectRatio)
        ? body.aspectRatio
        : (templateDefaults.aspectRatio || '9:16');
    const platform = cleanString(body.platform, templateDefaults.platform || '抖音', 60);
    const input = {
        productName: cleanString(body.productName, '未命名商品', 100),
        sellingPoints: cleanList(body.sellingPoints, 20),
    };
    const prompts = body.prompts && typeof body.prompts === 'object' ? body.prompts : {};
    const styleAnchor = cleanString(body.styleAnchor, template.styleAnchor, 1500);
    const complianceRules = cleanList(prompts.complianceRules || template.complianceRules, 30);
    const analyzeSystem = promptValue(prompts, 'analyze', 'analyzePrompt', template.analyzePrompt);
    const conceptSystem = promptValue(prompts, 'concept', 'conceptPrompt', template.conceptPrompt);
    const shotSystem = promptValue(prompts, 'shot', 'shotPrompt', template.shotPrompt);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = data => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send({ type: 'status', stage: 1, message: '第 1/3 步：正在分析产品 DNA…' });
        const dnaReply = await multimodalChat({
            system: `${analyzeSystem}

强制要求：只输出 JSON；所有文字使用中文；商品图是唯一视觉事实来源。不得因商品名或卖点而臆造图中不存在的包装、参数、认证和功效。`,
            prompt: `请分析商品图片并输出以下 JSON：
{
  "productDNA": {
    "productName": "商品名",
    "category": "品类，无法确认写待确认",
    "visualIdentity": {
      "shape": "形态与比例",
      "colors": ["主色与辅色"],
      "materials": ["可见材质"],
      "packaging": "包装结构、标签布局和辨识特征",
      "visibleText": ["图片中确实可辨认的文字"],
      "consistencyAnchor": "供后续每个镜头复用的完整视觉一致性描述"
    },
    "confirmedSellingPoints": ["图片或用户资料可支持的卖点"],
    "targetAudience": ["目标受众"],
    "usageScenarios": ["使用场景"],
    "uncertainties": ["无法从图片确认的信息"],
    "complianceRisks": ["可能需要改写或核实的广告表述"]
  }
}

【用户提供】
商品名：${input.productName}
卖点：${input.sellingPoints.join('；') || '未提供'}
参考图数量：${productImageUrls.length} 张（请综合正面、侧面、包装细节等角度，识别同一产品的稳定视觉特征）
行业模板：${template.industry}
合规规则：${complianceRules.join('；')}`,
            imageUrls: productImageUrls,
            libraryDir: req.app.locals.LIBRARY_DIR,
            maxTokens: 8000,
            temperature: 0.2,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 1, chars: total });
            },
        });
        const productDNA = normalizeProductDNA(parseStructuredJson(dnaReply, '产品 DNA 分析'), input);

        send({ type: 'status', stage: 2, message: '第 2/3 步：正在生成多套广告创意…' });
        const conceptReply = await textChat({
            system: `${conceptSystem}

所有内容使用中文。创意必须彼此差异明显，且只能使用产品 DNA 中已确认的信息。遵守广告合规规则，禁止绝对化、疗效化、虚构参数和虚构优惠。

生成前在内部完成创意质检，但不要输出思考过程：
- 每套创意是否只突出一个核心利益点，并对应一个真实购买动机；
- 钩子是否能在前三秒以具体画面成立，而非空泛标题党；
- 各创意的场景、叙事结构、视觉节奏和说服证据是否真正不同；
- 口播字数是否匹配成片时长，是否为自然中文口语；
- 是否存在无法由产品 DNA 证明的主张。

只输出严格 JSON，不要 Markdown、解释或附加文本。`,
            prompt: `基于以下资料生成恰好 ${conceptCount} 套创意：
平台：${platform}
画幅：${aspectRatio}
每条多图直出成片时长：${videoDuration} 秒；每套创意使用 ${shotsPerConcept} 张连续关键帧
时间轴：${timelineSpec}
风格锚点：${styleAnchor}
合规规则：${complianceRules.join('；')}
产品 DNA：${JSON.stringify(productDNA)}

输出字段要求：
- title：简洁的内部创意名称，不作为画面文案；
- hook：前三秒可拍摄的画面钩子及对应口播；
- angle：目标受众、核心痛点、唯一利益点和画面证明方式；
- script：按“开场钩子→产品出场→卖点证据→使用情境→利益落点→CTA”写成完整连续中文口播，总长度控制在 ${Math.floor(videoDuration * 3.5)}～${Math.ceil(videoDuration * 4)} 个汉字；
- cta：自然、克制、符合平台语境的行动号召；
- visualDirection / sceneWorld / colorLighting / propStrategy / rhythm：完整视觉导演矩阵；
- differentiation：说明本创意与其他创意在布景、构图、光线和节奏上的明确差异。

JSON：
{"concepts":[{"id":"concept-1","title":"标题","hook":"具体画面钩子及口播","angle":"受众、痛点、利益点与证明方式","script":"完整中文短视频口播脚本","cta":"合规行动号召","visualDirection":"整体视觉导演方案","sceneWorld":"独立场景世界","colorLighting":"色彩与灯光策略","propStrategy":"道具策略","rhythm":"镜头节奏","differentiation":"与其他创意的差异"}]}`,
            maxTokens: 12000,
            temperature: 0.7,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 2, chars: total });
            },
        });
        const concepts = normalizeConcepts(parseStructuredJson(conceptReply, '广告创意生成'), conceptCount, input);

        send({ type: 'status', stage: 3, message: '第 3/3 步：正在为每套创意生成分镜…' });
        const shotReply = await textChat({
            system: `${shotSystem}

强制要求：
1. 所有提示词、字幕、旁白和转场均用中文。
2. 每个镜头都必须重复产品视觉一致性锚点；商品包装、主色、材质、尺寸比例、标签位置和可见标识不得漂移。
3. imagePrompt 按“产品锚点→镜头职责→场景→景别/机位/焦段感→构图与主体位置→光线色温→材质细节→画幅与字幕安全区→负面约束”的顺序书写。
4. videoPrompt 按“产品锚点→起始状态→主体动作→单一运镜→速度节奏→结束状态→连续性→负面约束”的顺序书写。一个镜头只使用一种主运镜，禁止同时推拉摇移环绕。
5. 整条 ${videoDuration} 秒成片必须有足够但不过载的动作过程；关键帧之间在空间、光线、人物、道具和产品状态上连续。
6. 每张关键帧的字幕只承载一个重点，建议不超过 16 个汉字；整条旁白约 ${Math.max(8, Math.floor(videoDuration * 3.5))}～${Math.ceil(videoDuration * 4)} 个汉字，并与关键帧序列同步。
7. 每套分镜至少包含一次商品完整 Hero Shot 和一次能够证明卖点的特写/使用镜头；相邻镜头必须在景别、角度或运动中至少改变两项。
8. 不得生成图片中没有的品牌背书、参数、功效、价格、优惠或认证。
9. shots 是同一条视频的连续关键帧，不是相互独立的小视频。各帧必须有开始—发展—收束关系，并保持本创意的场景世界、色彩和光线连续。
10. 不同 concept 必须使用明显不同的布景、构图体系、光线策略、道具组合和叙事节奏；禁止只改变手势或轻微角度后重复同一张产品摆拍。

输出前在内部逐镜检查：商品是否一致、提示词是否可执行、动作是否适配时长、旁白是否匹配画面、镜头是否重复、负面约束是否完整。只输出严格 JSON。`,
            prompt: `请为每套创意生成恰好 ${shotsPerConcept} 张连续关键帧，并以这些关键帧直接生成一条约 ${videoDuration} 秒的完整视频。
固定时间轴：${timelineSpec}
每张关键帧必须覆盖自己的 startSec 到 endSec，不得合并、遗漏或改变顺序。每段 voiceover 最多为该段秒数 × 4 个汉字，整条旁白总长度不得超过 ${Math.ceil(videoDuration * 4)} 个汉字。
平台：${platform}
画幅：${aspectRatio}
风格锚点：${styleAnchor}
产品视觉一致性锚点：${productDNA.visualIdentity.consistencyAnchor}
合规规则：${complianceRules.join('；')}
产品 DNA：${JSON.stringify(productDNA)}
创意：${JSON.stringify(concepts)}

输出：
{"concepts":[{"id":"concept-1","shots":[{"index":1,"startSec":0,"endSec":2,"shotPurpose":"该时间段的叙事职责","scene":"具体场景与空间层次","shotSize":"景别","camera":"机位、角度与焦段感","composition":"构图与主体位置","action":"该时间段内完成的主体动作","imagePrompt":"完整专业中文生图提示词，含一致性锚点和负面约束","videoPrompt":"当前时间段及到下一关键帧的动作与运镜提示词","duration":2,"subtitle":"不超过12字的单一重点字幕","voiceover":"符合该段时长的自然中文旁白","transition":"具体视觉衔接方式"}]}]}`,
            maxTokens: Math.min(30000, 5000 + conceptCount * shotsPerConcept * 900),
            temperature: 0.45,
            onDelta: (_delta, total) => {
                if (total % 500 < 30) send({ type: 'progress', stage: 3, chars: total });
            },
        });
        const shotData = parseStructuredJson(shotReply, '广告分镜生成');
        const normalizedConcepts = normalizeShots(shotData, concepts, {
            shotsPerConcept,
            videoDuration,
            aspectRatio,
            styleAnchor,
            consistencyAnchor: productDNA.visualIdentity.consistencyAnchor,
        }).map(concept => ({
            ...concept,
            storyboardPrompt: buildStoryboardBoardPrompt(concept, {
                videoDuration,
                aspectRatio,
                industry: template.industry,
                productName: productDNA.productName,
                consistencyAnchor: productDNA.visualIdentity.consistencyAnchor,
            }),
        }));

        send({
            type: 'done',
            data: {
                title: `${productDNA.productName || '产品'}广告创意`,
                summary: `为${platform}生成 ${normalizedConcepts.length} 套独立广告创意，每套把 ${shotsPerConcept} 格时间轴分镜合成一张故事板母版并直出一条成片`,
                styleAnchor,
                templateId: template.id,
                industry: template.industry,
                productDNA,
                concepts: normalizedConcepts,
            },
        });
        res.end();
    } catch (error) {
        console.error('[product-workflow] analyze error:', error);
        send({ type: 'error', error: error.message || '产品一键出片分析失败' });
        res.end();
    }
});

export default router;
