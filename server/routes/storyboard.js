/**
 * storyboard.js
 * 
 * Routes for AI storyboard script generation.
 * 使用「设置」中配置的文字模型（OpenAI 兼容接口）生成分镜脚本，图片模型生成合成分镜图。
 */

import express from 'express';
import { gpt2apiChat, generateGpt2apiImage } from '../services/gpt2api.js';
import { getKey } from '../config.js';

const router = express.Router();

/**
 * Helper to retry async operations with exponential backoff
 */
async function retryOperation(operation, maxRetries = 3, initialDelayMs = 2000) {
    let delay = initialDelayMs;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            const isLastAttempt = i === maxRetries - 1;
            console.warn(`[Storyboard] API Call Failed (Attempt ${i + 1}/${maxRetries}):`, error.message);

            if (isLastAttempt) throw error;

            console.log(`[Storyboard] Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
        }
    }
}

/** 读取「设置」里的文字模型配置 */
function getTextConfig() {
    const apiKey = getKey('TEXT_API_KEY');
    if (!apiKey) throw new Error('未配置文字模型 KEY，请在「设置 → 文字模型」中填写');
    return {
        baseUrl: getKey('TEXT_API_URL'),
        apiKey,
        model: getKey('TEXT_MODEL') || 'grok-4.20-fast',
    };
}

/**
 * 把 Gemini 风格的 promptParts（字符串 / {text} / {inlineData}）转成 OpenAI 多模态消息
 */
function partsToMessages(parts) {
    const content = [];
    for (const p of parts) {
        if (typeof p === 'string') content.push({ type: 'text', text: p });
        else if (p?.text) content.push({ type: 'text', text: p.text });
        else if (p?.inlineData) {
            content.push({
                type: 'image_url',
                image_url: { url: `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}` },
            });
        }
    }
    return [{ role: 'user', content }];
}

/**
 * 调用文字模型；带参考图失败时自动降级为纯文本重试（部分模型不支持图片输入）
 */
async function chatWithImages(parts) {
    const cfg = getTextConfig();
    const messages = partsToMessages(parts);
    const hasImages = messages[0].content.some(c => c.type === 'image_url');
    try {
        return await retryOperation(() => gpt2apiChat({ messages, ...cfg }), 2, 1500);
    } catch (e) {
        if (!hasImages) throw e;
        console.warn('[Storyboard] 带图请求失败，降级为纯文本重试:', e.message);
        const textOnly = [{
            role: 'user',
            content: messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n\n'),
        }];
        return await retryOperation(() => gpt2apiChat({ messages: textOnly, ...cfg }), 2, 1500);
    }
}

// ============================================================================
// SCRIPT GENERATION
// ============================================================================

/**
 * Generate storyboard scripts using Gemini LLM
 * 
 * POST /api/storyboard/generate-scripts
 * Body: { story, characterDescriptions, sceneCount }
 * Returns: { scripts: [{ sceneNumber, description, cameraAngle, mood }] }
 */
router.post('/generate-scripts', async (req, res) => {
    try {
        const { story, characterDescriptions, sceneCount, referenceImages, characterImages } = req.body;
        const { resolveImageToBase64 } = await import('../utils/imageHelpers.js');

        if (!story || !sceneCount) {
            return res.status(400).json({
                error: "Missing required fields: story and sceneCount"
            });
        }

        // Validate sceneCount
        const count = parseInt(sceneCount, 10);
        if (isNaN(count) || count < 1 || count > 10) {
            return res.status(400).json({
                error: "sceneCount must be between 1 and 10"
            });
        }

        console.log(`[Storyboard] Generating ${count} scene scripts`);

        // Categorize reference images
        const refs = referenceImages || [];
        const characterRefs = refs.filter(r => r.category === 'Character');
        const sceneRefs = refs.filter(r => r.category === 'Scene');
        const itemRefs = refs.filter(r => r.category === 'Item');
        const styleRefs = refs.filter(r => r.category === 'Style');
        const otherRefs = refs.filter(r => !['Character', 'Scene', 'Item', 'Style'].includes(r.category));

        // Build reference context based on categories
        let referenceContext = '';

        if (characterRefs.length > 0) {
            referenceContext += `\n\nCHARACTER REFERENCES (create detailed "Character DNA" for each - MUST be consistent across all scenes):\n`;
            referenceContext += characterRefs.map((c, i) => `${i + 1}. ${c.name}: Use the provided reference image as the ABSOLUTE TRUTH for this character's appearance.`).join('\n');
        }

        if (sceneRefs.length > 0) {
            referenceContext += `\n\nSCENE/ENVIRONMENT REFERENCES (use these as visual inspiration for environments):\n`;
            referenceContext += sceneRefs.map((s, i) => `${i + 1}. ${s.name}: Incorporate this environment/setting style into relevant scenes.`).join('\n');
        }

        if (itemRefs.length > 0) {
            referenceContext += `\n\nPROP/ITEM REFERENCES (include these objects in scenes where appropriate):\n`;
            referenceContext += itemRefs.map((item, i) => `${i + 1}. ${item.name}: Feature this item/prop in the storyboard where it fits the narrative.`).join('\n');
        }

        if (styleRefs.length > 0) {
            referenceContext += `\n\nVISUAL STYLE REFERENCES (match this art style across ALL panels):\n`;
            referenceContext += styleRefs.map((s, i) => `${i + 1}. ${s.name}: Use this as the visual style guide for the entire storyboard.`).join('\n');
        }

        if (otherRefs.length > 0) {
            referenceContext += `\n\nADDITIONAL REFERENCES:\n`;
            referenceContext += otherRefs.map((r, i) => `${i + 1}. ${r.name}: Incorporate elements from this reference where appropriate.`).join('\n');
        }

        // Also support legacy characterDescriptions format
        const characterContext = characterDescriptions && characterDescriptions.length > 0 && !referenceContext
            ? `\n\nCHARACTERS (create a detailed "Character DNA" for each - this MUST be repeated verbatim in every scene):\n${characterDescriptions.map((c, i) => `${i + 1}. ${c.name}: ${c.description || 'Create a detailed physical description including age, ethnicity, hair style/color, distinctive features, and exact clothing'}`).join('\n')}`
            : '';

        const systemPrompt = `You are a professional film storyboard artist and cinematographer.

Create a cinematic storyboard that tells a REAL story like a movie scene, with professional camera work.

REQUIREMENTS:
1. **Character Consistency**: 
   - If reference images are provided, use them as the ABSOLUTE GROUND TRUTH for gender, age, clothing, and physical appearance.
   - If no image is provided, create a detailed specific look and keep it consistent.

2. **Cinematic Camera Progression**: Vary camera angles like a real film:
   - Scene 1: Establishing shot (Wide/Extreme wide) - set the scene
   - Middle scenes: Mix of Medium shots, Close-ups, Over-the-shoulder
   - Final scene: Impactful shot (can be wide for epic, or close-up for emotional)

3. **Story Arc**: Beginning → Rising action → Climax → Resolution

4. **Lighting Consistency**: Maintain logical lighting throughout (time of day, indoor/outdoor)

${referenceContext || characterContext}

STORY SYNOPSIS:
${story}

Generate exactly ${count} scenes. Return a JSON object with:
- "styleAnchor": A consistent style description (e.g., "photorealistic, cinematic lighting, 35mm film grain, high detail")
- "characterDNA": Object with detailed description for each character that stays CONSTANT
- "scenes": Array of scene objects

Each scene must have:
- "sceneNumber": Scene number
- "description": Detailed visual description (2-3 sentences) that:
  * Uses the character's NAME primarily (do NOT repeat their physical description every time if it's already in characterDNA)
  * Describes the action, environment, and emotion
  * Specifies lighting and atmosphere
- "cameraAngle": Professional camera terminology
- "cameraMovement": Static, Pan, Tilt, Dolly, Tracking, Crane, Handheld
- "lighting": Description of lighting
- "mood": Emotional tone

IMPORTANT: When referring to the specific characters listed above, YOU MUST use the format @CharacterName (e.g., if the character is "Shawn", write "@Shawn"). This triggers the asset link in the UI.

Example format:
{
  "styleAnchor": "photorealistic, cinematic, 35mm film, shallow depth of field",
  "characterDNA": {
    "Shawn": "Asian male, mid-20s, pink dyed wavy hair, round wire-frame glasses, clean-shaven, wearing light blue denim jacket over white t-shirt, dark jeans"
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "@Shawn stands in the doorway of an abandoned warehouse...",
      "cameraAngle": "Wide shot",
      "cameraMovement": "Static",
      "lighting": "Dusty beams of afternoon sunlight streaming through broken windows",
      "mood": "Mysterious, curious"
    }
  ]
}

Respond ONLY with valid JSON, no other text.`;

        // Process images for multimodal prompt
        const promptParts = [systemPrompt];

        // Process reference images for multimodal prompt (new format with categories)
        if (referenceImages && referenceImages.length > 0) {
            console.log('[Storyboard] Processing reference images for scripts...');
            for (const ref of referenceImages) {
                try {
                    const fullDataUrl = await resolveImageToBase64(ref.url);
                    if (fullDataUrl && fullDataUrl.startsWith('data:')) {
                        const matches = fullDataUrl.match(/^data:(.+);base64,(.+)$/);
                        if (matches) {
                            const mimeType = matches[1];
                            const rawBase64 = matches[2];

                            // Category-specific labels
                            let imageLabel;
                            switch (ref.category) {
                                case 'Character':
                                    imageLabel = `REFERENCE IMAGE FOR CHARACTER: ${ref.name}\n(This image is the visual truth for ${ref.name}. Ignore any conflicting text description. Ensure the script matches this character's gender, clothing, and appearance.)`;
                                    break;
                                case 'Scene':
                                    imageLabel = `REFERENCE IMAGE FOR SCENE/ENVIRONMENT: ${ref.name}\n(Use this as visual inspiration for environment, setting, and atmosphere in relevant scenes.)`;
                                    break;
                                case 'Item':
                                    imageLabel = `REFERENCE IMAGE FOR PROP/ITEM: ${ref.name}\n(Feature this item/object in scenes where appropriate to the narrative.)`;
                                    break;
                                case 'Style':
                                    imageLabel = `VISUAL STYLE REFERENCE: ${ref.name}\n(Use this image as the art style guide for ALL panels. Match the color palette, rendering technique, and visual aesthetic.)`;
                                    break;
                                default:
                                    imageLabel = `REFERENCE IMAGE: ${ref.name}\n(Incorporate elements from this reference where appropriate.)`;
                            }

                            promptParts.push(imageLabel);
                            promptParts.push({
                                inlineData: {
                                    data: rawBase64,
                                    mimeType: mimeType
                                }
                            });
                            console.log(`[Storyboard] Added ref image for scripts: ${ref.name} (${ref.category}, ${mimeType})`);
                        }
                    }
                } catch (e) {
                    console.error(`[Storyboard] Failed to process image for ${ref.name}:`, e.message);
                }
            }
        }
        // Fallback: support legacy characterImages format for backwards compatibility
        else if (characterImages && Object.keys(characterImages).length > 0) {
            console.log('[Storyboard] Processing character images for scripts...');
            for (const [name, url] of Object.entries(characterImages)) {
                try {
                    const fullDataUrl = await resolveImageToBase64(url);
                    if (fullDataUrl && fullDataUrl.startsWith('data:')) {
                        const matches = fullDataUrl.match(/^data:(.+);base64,(.+)$/);
                        if (matches) {
                            const mimeType = matches[1];
                            const rawBase64 = matches[2];

                            promptParts.push(`\nREFERENCE IMAGE FOR CHARACTER: ${name}\n(This image is the visual truth for ${name}. Ignore any conflicting text description. Ensure the script matches this character's gender, clothing, and appearance.)\n`);
                            promptParts.push({
                                inlineData: {
                                    data: rawBase64,
                                    mimeType: mimeType
                                }
                            });
                            console.log(`[Storyboard] Added ref image for scripts: ${name} (${mimeType})`);
                        }
                    }
                } catch (e) {
                    console.error(`[Storyboard] Failed to process image for ${name}:`, e.message);
                }
            }
        }

        // 调用配置的文字模型（带参考图，失败自动降级纯文本）
        const responseText = await chatWithImages(promptParts);

        // Parse JSON from response
        let parsed;
        try {
            // Try to extract JSON from the response (handle potential markdown code blocks)
            let jsonStr = responseText;
            if (responseText.includes('```json')) {
                jsonStr = responseText.split('```json')[1].split('```')[0].trim();
            } else if (responseText.includes('```')) {
                jsonStr = responseText.split('```')[1].split('```')[0].trim();
            }

            parsed = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error('[Storyboard] Failed to parse AI response:', parseError);
            console.error('[Storyboard] Raw response:', responseText);
            return res.status(500).json({
                error: "Failed to parse AI response. Please try again."
            });
        }

        // Extract data from parsed response
        const { styleAnchor, characterDNA, scenes } = parsed;
        const scripts = scenes || parsed.scripts || parsed;

        // Validate scripts array
        if (!Array.isArray(scripts) || scripts.length === 0) {
            return res.status(500).json({
                error: "AI returned invalid script format. Please try again."
            });
        }

        console.log(`[Storyboard] Generated ${scripts.length} scripts successfully`);

        return res.json({
            scripts,
            styleAnchor: styleAnchor || 'photorealistic, cinematic lighting, high detail',
            characterDNA: characterDNA || {}
        });

    } catch (error) {
        console.error("[Storyboard] Script Generation Error:", error);
        res.status(500).json({ error: error.message || "Script generation failed" });
    }
});

// ============================================================================
// STORY BRAINSTORMING
// ============================================================================

/**
 * Brainstorm a story using Gemini LLM based on selected characters
 * 
 * POST /api/storyboard/brainstorm-story
 * Body: { characterDescriptions, genre? }
 * Returns: { story: string }
 */
router.post('/brainstorm-story', async (req, res) => {
    try {
        const { characterDescriptions, genre, referenceImages, characterImages } = req.body;
        const { resolveImageToBase64 } = await import('../utils/imageHelpers.js');

        console.log(`[Storyboard] Brainstorming story with ${characterDescriptions?.length || 0} characters`);

        // Build character context
        const characterContext = characterDescriptions && characterDescriptions.length > 0
            ? `Characters to feature in the story:\n${characterDescriptions.map((c, i) => `${i + 1}. ${c.name}: ${c.description || 'A unique character'}`).join('\n')}`
            : 'Create original characters as needed for the story.';

        const genreHint = genre ? `\nGenre preference: ${genre}` : '';

        const systemPrompt = `You are a creative storyteller specializing in visual narratives perfect for storyboards.
        
${characterContext}${genreHint}

Create a compelling, concise story synopsis (3-5 sentences) that would make for an exciting visual storyboard.
The story should:
- Have a clear beginning, middle, and end
- Include vivid visual moments that would look great as images
- Feature the characters in interesting situations
- Be suitable for AI image generation
- INCORPORATE VISUAL DETAILS from the provided reference images where applicable.

IMPORTANT: When referring to the specific characters listed above, YOU MUST use the format @CharacterName (e.g., if the character is "Shawn", write "@Shawn"). This triggers the asset link in the UI.

Respond with ONLY the story synopsis, no additional text or formatting.`;

        // Process reference images for multimodal prompt
        const promptParts = [systemPrompt];

        if (referenceImages && referenceImages.length > 0) {
            console.log('[Storyboard] Processing reference images for brainstorming...');
            for (const ref of referenceImages) {
                try {
                    const fullDataUrl = await resolveImageToBase64(ref.url);
                    if (fullDataUrl && fullDataUrl.startsWith('data:')) {
                        const matches = fullDataUrl.match(/^data:(.+);base64,(.+)$/);
                        if (matches) {
                            promptParts.push(`REFERENCE IMAGE: ${ref.name} (${ref.category}) - Use visuals from this image for inspiration.`);
                            promptParts.push({
                                inlineData: {
                                    data: matches[2],
                                    mimeType: matches[1]
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[Storyboard] Failed to process image for ${ref.name}:`, e.message);
                }
            }
        }
        // Fallback for legacy
        else if (characterImages && Object.keys(characterImages).length > 0) {
            for (const [name, url] of Object.entries(characterImages)) {
                try {
                    const fullDataUrl = await resolveImageToBase64(url);
                    if (fullDataUrl && fullDataUrl.startsWith('data:')) {
                        const matches = fullDataUrl.match(/^data:(.+);base64,(.+)$/);
                        if (matches) {
                            promptParts.push(`REFERENCE IMAGE: ${name}`);
                            promptParts.push({
                                inlineData: {
                                    data: matches[2],
                                    mimeType: matches[1]
                                }
                            });
                        }
                    }
                } catch (e) { console.error(e); }
            }
        }

        // 调用配置的文字模型（带参考图，失败自动降级纯文本）
        const story = (await chatWithImages(promptParts)).trim();

        console.log(`[Storyboard] Generated story: ${story.substring(0, 100)}...`);

        return res.json({ story });

    } catch (error) {
        console.error("[Storyboard] Story Brainstorm Error:", error);
        res.status(500).json({ error: error.message || "Story brainstorming failed" });
    }
});

// ============================================================================
// STORY OPTIMIZATION
// ============================================================================

/**
 * Optimize an existing story idea for visual storyboard generation
 * 
 * POST /api/storyboard/optimize-story
 * Body: { story: string }
 * Returns: { optimizedStory: string }
 */
router.post('/optimize-story', async (req, res) => {
    try {
        const { story, characterNames } = req.body;

        if (!story || typeof story !== 'string') {
            return res.status(400).json({
                error: "Missing required field: story"
            });
        }

        console.log(`[Storyboard] Optimizing story length: ${story.length} chars`);

        const systemPrompt = `You are an expert storyboard artist and writer.
        
Your task is to REWRITE and OPTIMIZE the following story idea to make it perfect for AI image generation and storyboard creation.

ORIGINAL STORY:
"${story}"

INSTRUCTIONS:
1. Keep the core narrative, characters, and key events exactly the same.
2. Enhance visual descriptors (lighting, mood, environment, action).
3. Make the language concise, punchy, and cinematic.
4. Ensure clarity of action for each potential scene.
5. Do NOT make it too long (keep it under 150 words).
6. IMPORTANT: Ensure that any mentions of the following characters use the @Name syntax: ${characterNames && characterNames.length > 0 ? characterNames.join(', ') : 'None'}. For example, use "@Shawn" instead of "Shawn". This is critical.

Respond with ONLY the optimized story text.`;

        const optimizedStory = (await chatWithImages([systemPrompt])).trim();

        console.log(`[Storyboard] Optimized story: ${optimizedStory.substring(0, 50)}...`);

        return res.json({ optimizedStory });

    } catch (error) {
        console.error("[Storyboard] Story Optimization Error:", error);
        res.status(500).json({ error: error.message || "Story optimization failed" });
    }
});

// ============================================================================
// COMPOSITE STORYBOARD GENERATION
// ============================================================================

/**
 * Generate a composite storyboard image with all scenes in a grid
 * 
 * POST /api/storyboard/generate-composite
 * Body: { scripts, styleAnchor, characterDNA, sceneCount }
 * Returns: { imageUrl: string }
 */
router.post('/generate-composite', async (req, res) => {
    try {
        const { scripts, styleAnchor, characterDNA, sceneCount, referenceImages, characterImages } = req.body;
        const { resolveImageToBase64 } = await import('../utils/imageHelpers.js');

        if (!scripts || scripts.length === 0) {
            return res.status(400).json({
                error: "Missing required field: scripts"
            });
        }

        const count = scripts.length;
        console.log(`[Storyboard] Request Recieved: Generating composite image with ${count} panels`);

        // Log deep debug info
        console.log(`[Storyboard] Style Anchor: ${styleAnchor?.substring(0, 50)}...`);
        console.log(`[Storyboard] Character DNA Keys: ${characterDNA ? Object.keys(characterDNA).join(', ') : 'None'}`);
        console.log(`[Storyboard] Reference Images: ${referenceImages ? referenceImages.map(r => `${r.name}(${r.category})`).join(', ') : 'None'}`);

        // Determine grid layout based on scene count
        let layout;
        if (count <= 3) layout = `1x${count}`;
        else if (count === 4) layout = '2x2';
        else if (count <= 6) layout = '2x3';
        else if (count <= 9) layout = '3x3';
        else layout = '2x5';

        // Helper to normalize names for matching (remove spaces, lowercase)
        const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Prepare multimodal prompt parts
        const promptParts = [];
        let hasReferenceImages = false;
        let hasStyleReference = false;
        const scriptNamesWithImages = new Set();

        // Process reference images with categories (new format)
        if (referenceImages && referenceImages.length > 0) {
            console.log('[Storyboard] Processing categorized reference images...');
            for (const ref of referenceImages) {
                if (!ref.url) continue;

                try {
                    console.log(`[Storyboard] Resolving image for: ${ref.name} (${ref.category})`);
                    const base64Data = resolveImageToBase64(ref.url);
                    if (base64Data) {
                        const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
                        if (matches) {
                            const mimeType = matches[1];
                            const dataLength = matches[2].length;
                            console.log(`[Storyboard] Resolved ${ref.name}: ${mimeType}, Size: ${(dataLength / 1024 / 1024).toFixed(2)} MB`);

                            // Category-specific handling
                            let imageLabel;
                            switch (ref.category) {
                                case 'Character':
                                    // Try to find matching script name from DNA keys
                                    let linkedScriptName = ref.name;
                                    if (characterDNA) {
                                        const normName = normalize(ref.name);
                                        const match = Object.keys(characterDNA).find(k => normalize(k) === normName);
                                        if (match) linkedScriptName = match;
                                        else {
                                            const partialMatch = Object.keys(characterDNA).find(k => normalize(k).includes(normName) || normName.includes(normalize(k)));
                                            if (partialMatch) linkedScriptName = partialMatch;
                                        }
                                    }
                                    scriptNamesWithImages.add(linkedScriptName);
                                    imageLabel = `REFERENCE IMAGE for character "${ref.name}". In the scripts, this character is referred to as "@${ref.name}" or "${ref.name}". (This image is the ABSOLUTE TRUTH for their appearance).`;
                                    break;
                                case 'Scene':
                                    imageLabel = `SCENE/ENVIRONMENT REFERENCE "${ref.name}" (@${ref.name}) - use this for environment, setting, and atmosphere inspiration:`;
                                    break;
                                case 'Item':
                                    imageLabel = `PROP/ITEM REFERENCE "${ref.name}" (@${ref.name}) - feature this item in scenes where narrative-appropriate:`;
                                    break;
                                case 'Style':
                                    // ... existing style logic ...
                                    imageLabel = `VISUAL STYLE REFERENCE "${ref.name}" - match this art style, color palette, and rendering technique across ALL panels:`;
                                    hasStyleReference = true;
                                    break;
                                default:
                                    imageLabel = `REFERENCE IMAGE "${ref.name}" (@${ref.name}):`;
                            }

                            promptParts.push({ text: imageLabel });
                            promptParts.push({
                                inlineData: {
                                    mimeType: mimeType,
                                    data: matches[2]
                                }
                            });
                            hasReferenceImages = true;
                            console.log(`[Storyboard] Added reference image for ${ref.name} (${ref.category})`);
                        }
                    } else {
                        console.warn(`[Storyboard] Failed to resolve base64 for ${ref.url}`);
                    }
                } catch (err) {
                    console.warn(`[Storyboard] Failed to resolve image for ${ref.name}:`, err.message);
                }
            }
        }
        // Fallback: support legacy characterImages format for backwards compatibility
        else if (characterImages && Object.keys(characterImages).length > 0) {
            console.log('[Storyboard] Processing character reference images (legacy format)...');
            for (const [name, url] of Object.entries(characterImages)) {
                if (!url) continue;

                try {
                    console.log(`[Storyboard] Resolving image for: ${name}`);
                    const base64Data = resolveImageToBase64(url);
                    if (base64Data) {
                        const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
                        if (matches) {
                            const mimeType = matches[1];
                            const dataLength = matches[2].length;
                            console.log(`[Storyboard] Resolved ${name}: ${mimeType}, Size: ${(dataLength / 1024 / 1024).toFixed(2)} MB`);

                            // Try to find matching script name from DNA keys
                            let linkedScriptName = name;
                            if (characterDNA) {
                                const normName = normalize(name);
                                const match = Object.keys(characterDNA).find(k => normalize(k) === normName);
                                if (match) linkedScriptName = match;
                                else {
                                    // If no direct match, check for partial match
                                    const partialMatch = Object.keys(characterDNA).find(k => normalize(k).includes(normName) || normName.includes(normalize(k)));
                                    if (partialMatch) linkedScriptName = partialMatch;
                                }
                            }

                            // Track that this character has an image so we can strip text descriptions later
                            scriptNamesWithImages.add(linkedScriptName);

                            promptParts.push({ text: `REFERENCE IMAGE for character "${name}" (referred to as "${linkedScriptName}" in script):` });
                            promptParts.push({
                                inlineData: {
                                    mimeType: mimeType,
                                    data: matches[2]
                                }
                            });
                            hasReferenceImages = true;
                            console.log(`[Storyboard] Added reference image for ${name} (linked to ${linkedScriptName})`);
                        }
                    } else {
                        console.warn(`[Storyboard] Failed to resolve base64 for ${url}`);
                    }
                } catch (err) {
                    console.warn(`[Storyboard] Failed to resolve image for ${name}:`, err.message);
                }
            }
        }

        // Build character DNA context
        // FILTERED: Remove DNA descriptions for characters that have reference images
        const characterDNAContext = characterDNA && Object.keys(characterDNA).length > 0
            ? `\n\nCHARACTER APPEARANCES (must be consistent across ALL panels):\n${Object.entries(characterDNA)
                .filter(([name]) => !scriptNamesWithImages.has(name)) // OMIT if image exists
                .map(([name, desc]) => `- ${name}: ${desc}`)
                .join('\n')
            }`
            : '';

        // Build the composite generation prompt
        // STRIPPED: Remove parenthetical descriptions from scripts for characters with images
        const panelDescriptions = scripts.map((script, i) => {
            let cleanDesc = script.description;

            // For characters with images, strip their text description aggressively
            for (const name of scriptNamesWithImages) {
                // Escape name for regex
                const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // Regex matches: Name (optional 's) followed by optional whitespace and ANY parenthetical group
                // We look for name, maybe 's, maybe space, then an opening paren
                const regex = new RegExp(`${escapedName}(?:'s)?\\s*\\([^)]+\\)`, 'gi');

                const before = cleanDesc;
                cleanDesc = cleanDesc.replace(regex, (match) => {
                    // Return just the name part (stripping the parenthesis)
                    return match.split('(')[0].trim();
                });

                if (before !== cleanDesc) {
                    console.log(`[Storyboard] STRIPPED description for ${name} in Panel ${i + 1}`);
                    console.log(`   BEFORE: ${before.substring(before.indexOf(name), before.indexOf(name) + 50)}...`);
                    console.log(`   AFTER:  ${cleanDesc.substring(cleanDesc.indexOf(name), cleanDesc.indexOf(name) + 20)}...`);
                } else {
                    console.log(`[Storyboard] NO MATCH for ${name} in Panel ${i + 1} (Regex: ${regex})`);
                }
            }

            return `Panel ${i + 1}: ${cleanDesc}. Camera: ${script.cameraAngle}. Mood: ${script.mood}.`;
        }).join('\n');

        console.log('[Storyboard] Panel Descriptions Being Sent to Gemini:');
        console.log(panelDescriptions.substring(0, 500) + '...');

        // FORCE UNIFORM aspect ratio and layout
        const [rows, cols] = layout.split('x');
        const compositePrompt = `Create a cohesive, professional movie storyboard sheet with ${count} panels.
        
LAYOUT INSTRUCTIONS:
- STRICT ${rows}x${cols} GRID (${rows} rows, ${cols} columns).
- ALL PANELS MUST BE EXACTLY THE SAME SIZE AND ASPECT RATIO.
- NO COLLAGES. NO VARYING ASPECT RATIOS. NO DUPLICATE PANELS.
- Do NOT Create a 2x2 grid if 1x3 is requested.
- The layout must be a perfect, regular grid.
- Draw distinct borders between panels.
- Add HIGH-CONTRAST WHITE SCENE NUMBERS (1, 2, 3...) in the top-left corner of each panel.

${hasReferenceImages ? 'IMPORTANT: USE THE PROVIDED REFERENCE IMAGES as the ABSOLUTE GROUND TRUTH for the characters\' appearance, gender, and clothing. \n- If the character name (e.g. "Fashion Model") implies a specific gender/look but the image shows otherwise, OBEY THE IMAGE.\n- Do NOT default to stereotypes. The image is the only truth.' : ''}
        
STORY CONTEXT: The panels depict a sequence where the environment changes according to the script.
        
ART STYLE: ${styleAnchor || 'photorealistic, cinematic lighting, detailed illustration'}
Maintain this exact art style, color grading, and rendering technique across all panels.

${hasReferenceImages ? 'IMPORTANT: USE THE PROVIDED REFERENCE IMAGES as the ABSOLUTE GROUND TRUTH for the characters\' facial features, hair, and body type. Do NOT change their identity. If the text description conflicts with the reference image regarding physical appearance, FOLLOW THE IMAGE. The provided scripts have stripped text descriptions for these characters to rely solely on your visual understanding of the reference image.' : ''}
        
${characterDNAContext}
        
PANEL INSTRUCTIONS (Note: "@Name" refers to the specific reference image for that character/item):
${panelDescriptions}
        
CRITICAL: 
1. Draw all panels on a SINGLE sheet with thin borders separating them.
2. Keep character faces, body types, and clothing details 100% consistent with the reference images/descriptions.
3. LABELING: ADD A VISIBLE, HIGH-CONTRAST WHITE NUMBER (1, ${count > 1 ? '2, ' : ''}...) in the corner of each panel.`;

        console.log(`[Storyboard] Composite prompt preview: ${compositePrompt.substring(0, 100)}...`);

        // 用「设置」中配置的图片模型生成合成分镜图（参考图作为图生图输入）
        const imageApiKey = getKey('IMAGE_API_KEY');
        if (!imageApiKey) {
            return res.status(500).json({ error: '未配置图片模型 KEY，请在「设置 → 图片模型」中填写' });
        }
        // 把参考图标签拼进提示词，参考图本体作为图生图输入
        const refLabels = promptParts.filter(p => p.text).map(p => p.text);
        const refImages = promptParts
            .filter(p => p.inlineData)
            .map(p => `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}`);
        const fullPrompt = [...refLabels, compositePrompt].join('\n\n');

        console.log(`[Storyboard] Sending composite request to image model... refs: ${refImages.length}`);
        const startTime = Date.now();
        const { buffer: imageBuffer, format } = await retryOperation(() => generateGpt2apiImage({
            prompt: fullPrompt,
            imageBase64Array: refImages,
            aspectRatio: '16:9',
            resolution: '2K',
            model: getKey('IMAGE_MODEL') || 'nano-banana-pro',
            baseUrl: getKey('IMAGE_API_URL'),
            apiKey: imageApiKey,
        }), 2, 2000);
        console.log(`[Storyboard] Composite image generated in ${Date.now() - startTime}ms`);

        const fileName = `storyboard_composite_${Date.now()}.${format || 'png'}`;
        const fsp = await import('fs/promises');
        const pathMod = await import('path');
        const assetsDir = req.app.locals.IMAGES_DIR || './library/images';
        await fsp.writeFile(pathMod.join(assetsDir, fileName), imageBuffer);
        const imageUrl = `/library/images/${fileName}`;
        console.log(`[Storyboard] Composite image saved: ${imageUrl}`);

        return res.json({ imageUrl });

    } catch (error) {
        console.error("[Storyboard] Composite Generation Error:", error);
        res.status(500).json({ error: error.message || "Composite generation failed" });
    }
});

export default router;
