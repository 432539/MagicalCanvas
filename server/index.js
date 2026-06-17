// Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn } from 'child_process';
import chatAgent from './agent/index.js';
import generationRoutes from './routes/generation.js';
import localModelsRoutes from './routes/local-models.js';
import storyboardRoutes from './routes/storyboard.js';
import videoStudioRoutes from './routes/video-studio.js';
import storyWorkflowRoutes from './routes/story-workflow.js';
import promptTemplatesRoutes from './routes/prompt-templates.js';
import { getKey, getAllSettings, saveConfig, SETTINGS_KEYS } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3501;

// Ensure library directories exist
const LIBRARY_DIR = process.env.LIBRARY_DIR || path.join(__dirname, '..', 'library');
const WORKFLOWS_DIR = path.join(LIBRARY_DIR, 'workflows');
const IMAGES_DIR = path.join(LIBRARY_DIR, 'images');
const VIDEOS_DIR = path.join(LIBRARY_DIR, 'videos');
const CHATS_DIR = path.join(LIBRARY_DIR, 'chats');
const LIBRARY_ASSETS_DIR = path.join(LIBRARY_DIR, 'assets');
const EDIT_PROJECTS_DIR = path.join(LIBRARY_DIR, 'edit-projects');

[LIBRARY_DIR, WORKFLOWS_DIR, IMAGES_DIR, VIDEOS_DIR, CHATS_DIR, LIBRARY_ASSETS_DIR, EDIT_PROJECTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Enable CORS for all routes (must come before static file serving)
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// 健康检查：供 Electron 主进程确认 3501 端口上运行的是本应用（而非其他程序）
app.get('/api/health', (req, res) => {
    res.json({ app: 'magical-canvas', mode: process.env.NODE_ENV || 'development' });
});

// Serve static assets from library with CORS headers for cross-origin image access
app.use('/library', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}, express.static(LIBRARY_DIR));


const getClient = () => {
    return new GoogleGenAI({ apiKey: getKey('GEMINI_API_KEY') });
};

// ============================================================================
// KLING AI CONFIGURATION
// ============================================================================

const KLING_BASE_URL = 'https://api-singapore.klingai.com';

// ============================================================================
// API KEY CONFIGURATION
// ----------------------------------------------------------------------------
// Keys are resolved dynamically (config file > environment) so the in-app
// Settings page can update them without restarting the server.
// ============================================================================

// Expose every settings key to route modules via app.locals as live getters,
// so `req.app.locals.GEMINI_API_KEY` always reflects the latest saved value.
for (const key of SETTINGS_KEYS) {
    Object.defineProperty(app.locals, key, {
        get() { return getKey(key); },
        enumerable: true,
        configurable: true,
    });
}

app.locals.IMAGES_DIR = IMAGES_DIR;
app.locals.VIDEOS_DIR = VIDEOS_DIR;
app.locals.LIBRARY_DIR = LIBRARY_DIR;

// Mirror resolved settings into process.env so route/service modules that read
// process.env directly (Twitter, TikTok, etc.) also pick up saved values live.
const applyConfigToEnv = () => {
    for (const key of SETTINGS_KEYS) {
        const value = getKey(key);
        if (value) process.env[key] = value;
    }
};
applyConfigToEnv();

// Startup diagnostics (non-fatal warnings)
(() => {
    if (!getKey('TEXT_API_KEY')) console.warn("SERVER WARNING: 文字模型 KEY 未配置（聊天不可用）。请在「设置」中填写。");
    if (!getKey('IMAGE_API_KEY')) console.warn("SERVER WARNING: 图片模型 KEY 未配置（图像生成不可用）。请在「设置」中填写。");
    if (!getKey('VIDEO_API_KEY')) console.warn("SERVER WARNING: 视频模型 KEY 未配置（视频生成不可用）。请在「设置」中填写。");
})();

// ============================================================================
// SETTINGS API (read/write API keys from the in-app Settings page)
// ============================================================================

// Return current values for all settings keys (localhost desktop app).
app.get('/api/settings', (req, res) => {
    try {
        res.json({ success: true, settings: getAllSettings(), keys: SETTINGS_KEYS });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Persist updated settings. Takes effect immediately (no restart needed).
app.post('/api/settings', (req, res) => {
    try {
        const updates = (req.body && req.body.settings) ? req.body.settings : req.body;
        const merged = saveConfig(updates || {});
        applyConfigToEnv();
        res.json({ success: true, settings: merged });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to save settings' });
    }
});

// ============================================================================
// WORKFLOW SANITIZATION HELPERS
// ============================================================================

/**
 * Saves base64 data URL to a file and returns the file URL path.
 * @param {string} dataUrl - Base64 data URL (e.g., data:image/png;base64,...)
 * @returns {{ url: string } | null} - File URL path or null if not base64
 */
function saveBase64ToFile(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return null;
    }

    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return null;

    const mimeType = matches[1];
    const base64Data = matches[2];

    try {
        const buffer = Buffer.from(base64Data, 'base64');
        const id = `wf_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        let filename, targetDir, urlType;

        if (mimeType.startsWith('video/')) {
            filename = `${id}.mp4`;
            targetDir = VIDEOS_DIR;
            urlType = 'videos';
        } else {
            const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
            filename = `${id}.${ext}`;
            targetDir = IMAGES_DIR;
            urlType = 'images';
        }

        fs.writeFileSync(path.join(targetDir, filename), buffer);
        console.log(`  [Workflow Sanitize] Saved base64 → /library/${urlType}/${filename}`);

        return { url: `/library/${urlType}/${filename}` };
    } catch (err) {
        console.error('  [Workflow Sanitize] Failed to save base64:', err.message);
        return null;
    }
}

/**
 * Sanitizes workflow nodes by converting base64 data to file URLs.
 * Prevents large base64 strings from bloating workflow JSON files.
 * @param {Array} nodes - Array of workflow nodes
 * @returns {Array} - Sanitized nodes with file URLs instead of base64
 */
function sanitizeWorkflowNodes(nodes) {
    if (!nodes || !Array.isArray(nodes)) return nodes;

    let sanitizedCount = 0;

    const sanitized = nodes.map(node => {
        const cleanNode = { ...node };

        // Check resultUrl for base64 data
        if (cleanNode.resultUrl && cleanNode.resultUrl.startsWith('data:')) {
            const saved = saveBase64ToFile(cleanNode.resultUrl);
            if (saved) {
                cleanNode.resultUrl = saved.url;
                sanitizedCount++;
            }
        }

        // Check lastFrame for base64 data (video nodes)
        if (cleanNode.lastFrame && cleanNode.lastFrame.startsWith('data:')) {
            const saved = saveBase64ToFile(cleanNode.lastFrame);
            if (saved) {
                cleanNode.lastFrame = saved.url;
                sanitizedCount++;
            }
        }

        // Check editorCanvasData for base64 data (Image Editor)
        if (cleanNode.editorCanvasData && cleanNode.editorCanvasData.startsWith('data:')) {
            const saved = saveBase64ToFile(cleanNode.editorCanvasData);
            if (saved) {
                cleanNode.editorCanvasData = saved.url;
                sanitizedCount++;
            }
        }

        // Check editorBackgroundUrl for base64 data (Image Editor)
        if (cleanNode.editorBackgroundUrl && cleanNode.editorBackgroundUrl.startsWith('data:')) {
            const saved = saveBase64ToFile(cleanNode.editorBackgroundUrl);
            if (saved) {
                cleanNode.editorBackgroundUrl = saved.url;
                sanitizedCount++;
            }
        }

        return cleanNode;
    });

    if (sanitizedCount > 0) {
        console.log(`[Workflow Sanitize] Converted ${sanitizedCount} base64 field(s) to file URLs`);
    }

    return sanitized;
}

// Mount generation routes (image and video generation)
app.use('/api', generationRoutes);

// Mount Video Studio routes (clip editing, TTS, subtitles, export)
app.use('/api/video-studio', videoStudioRoutes);

// Mount Local Models routes (local open-source model discovery)
app.use('/api/local-models', localModelsRoutes);

// Mount Storyboard routes (AI script generation)
app.use('/api/storyboard', storyboardRoutes);

// Mount story workflow routes (一键创建工作流)
app.use('/api/story-workflow', storyWorkflowRoutes);
app.use('/api/prompt-templates', promptTemplatesRoutes);

// NOTE: Old Kling helpers removed - now in server/services/kling.js

// --- Library Assets API ---

// Save curated asset to library
app.post('/api/library', async (req, res) => {
    try {
        const { sourceUrl, name, category, meta } = req.body;

        if (!sourceUrl || !name || !category) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Determine destination directory
        const destDir = path.join(LIBRARY_ASSETS_DIR, category);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        // Sanitize name for filesystem
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        let destFilename;
        let destPath;

        // HANDLE DATA URL (Base64)
        if (sourceUrl.startsWith('data:')) {
            const matches = sourceUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                return res.status(400).json({ error: 'Invalid data URL format' });
            }

            const mimeType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');

            // Determine extension from mime
            const mimeExt = {
                'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
                'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
            };
            const ext = mimeExt[mimeType] || (mimeType.startsWith('video/') ? '.mp4' : '.png');

            destFilename = `${safeName}${ext}`;
            destPath = path.join(destDir, destFilename);
            // 避免清洗后的同名文件互相覆盖（如中文文件名都变成下划线）
            while (fs.existsSync(destPath)) {
                destFilename = `${safeName}_${Date.now()}${ext}`;
                destPath = path.join(destDir, destFilename);
            }

            fs.writeFileSync(destPath, buffer);
        }
        // HANDLE FILE PATH OR URL
        else {
            // Determine source file path
            let sourcePath = null;

            // Normalize URL: remove origin if present to get just the path
            let cleanUrl = sourceUrl;
            try {
                // If it's a full URL, extract pathname
                if (sourceUrl.startsWith('http')) {
                    const u = new URL(sourceUrl);
                    cleanUrl = u.pathname;
                }
            } catch (e) {
                // Not a valid URL, treat as path
            }

            // Always strip query string (cache busting params like ?t=123)
            cleanUrl = cleanUrl.split('?')[0];

            // Ensure cleanUrl starts with / if it doesn't (though URL.pathname does)
            if (!cleanUrl.startsWith('/')) cleanUrl = '/' + cleanUrl;

            // Handle URL decoding (e.g. %20 -> space)
            cleanUrl = decodeURIComponent(cleanUrl);

            if (cleanUrl.startsWith('/library/images/')) {
                sourcePath = path.join(IMAGES_DIR, cleanUrl.replace('/library/images/', ''));
            } else if (cleanUrl.startsWith('/library/videos/')) {
                sourcePath = path.join(VIDEOS_DIR, cleanUrl.replace('/library/videos/', ''));
            } else if (cleanUrl.startsWith('/assets/images/')) { // Legacy support
                sourcePath = path.join(IMAGES_DIR, cleanUrl.replace('/assets/images/', ''));
            } else if (cleanUrl.startsWith('/assets/videos/')) { // Legacy support
                sourcePath = path.join(VIDEOS_DIR, cleanUrl.replace('/assets/videos/', ''));
            }

            if (!sourcePath || !fs.existsSync(sourcePath)) {
                console.error(`Save asset failed: Source file not found. URL: ${sourceUrl}, Path: ${sourcePath}`);
                return res.status(404).json({ error: "Source file not found", debug: { sourceUrl, sourcePath, cleanUrl } });
            }

            // Copy file
            const ext = path.extname(sourcePath);
            destFilename = `${safeName}${ext}`;
            destPath = path.join(destDir, destFilename);

            fs.copyFileSync(sourcePath, destPath);
        }

        // Update assets.json
        const libraryJsonPath = path.join(LIBRARY_ASSETS_DIR, 'assets.json');
        let libraryData = [];
        if (fs.existsSync(libraryJsonPath)) {
            libraryData = JSON.parse(fs.readFileSync(libraryJsonPath, 'utf8'));
        }

        const newEntry = {
            id: crypto.randomUUID(),
            name: name,
            category: category,
            url: `/library/assets/${category}/${destFilename}`,
            type: sourceUrl.includes('video') || (sourceUrl.startsWith('data:video')) ? 'video' : 'image',
            createdAt: new Date().toISOString(),
            ...meta
        };

        libraryData.push(newEntry);
        fs.writeFileSync(libraryJsonPath, JSON.stringify(libraryData, null, 2));

        res.json({ success: true, asset: newEntry });
    } catch (error) {
        console.error("Save to library error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ---- 素材分类管理（categories.json 持久化完整分类列表，全部可增删） ----
const DEFAULT_CATEGORIES = ['Character', 'Scene', 'Item', 'Style', 'Sound Effect', 'Others'];
const categoriesJsonPath = () => path.join(LIBRARY_ASSETS_DIR, 'categories.json');

function loadCategories() {
    try {
        if (fs.existsSync(categoriesJsonPath())) {
            const parsed = JSON.parse(fs.readFileSync(categoriesJsonPath(), 'utf8'));
            // 旧格式：数组里只存自定义分类 → 与默认分类合并迁移
            if (Array.isArray(parsed)) {
                return [...DEFAULT_CATEGORIES, ...parsed.filter(c => typeof c === 'string' && c.trim() && !DEFAULT_CATEGORIES.includes(c))];
            }
            if (parsed && Array.isArray(parsed.all)) {
                const list = parsed.all.filter(c => typeof c === 'string' && c.trim());
                if (list.length > 0) return list;
            }
        }
    } catch (_) { /* 损坏时回退默认分类 */ }
    return [...DEFAULT_CATEGORIES];
}

function saveCategories(list) {
    fs.writeFileSync(categoriesJsonPath(), JSON.stringify({ all: list }, null, 2));
}

app.get('/api/library/categories', (req, res) => {
    res.json({ categories: loadCategories() });
});

app.post('/api/library/categories', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    const categories = loadCategories();
    if (name === 'All' || categories.includes(name)) {
        return res.status(409).json({ error: '该分类已存在' });
    }
    categories.push(name);
    saveCategories(categories);
    res.json({ categories });
});

app.delete('/api/library/categories/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const categories = loadCategories();
    if (!categories.includes(name)) return res.status(404).json({ error: '分类不存在' });
    if (categories.length <= 1) return res.status(400).json({ error: '至少保留一个分类' });
    const next = categories.filter(c => c !== name);
    saveCategories(next);
    // 该分类下的素材改挂到剩余分类（优先 Others），文件不动
    const fallback = next.includes('Others') ? 'Others' : next[next.length - 1];
    const libraryJsonPath = path.join(LIBRARY_ASSETS_DIR, 'assets.json');
    if (fs.existsSync(libraryJsonPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(libraryJsonPath, 'utf8'));
            let changed = false;
            for (const a of data) {
                if (a.category === name) { a.category = fallback; changed = true; }
            }
            if (changed) fs.writeFileSync(libraryJsonPath, JSON.stringify(data, null, 2));
        } catch (_) { /* assets.json 损坏时跳过迁移 */ }
    }
    res.json({ categories: next });
});

// List library assets
app.get('/api/library', async (req, res) => {
    try {
        const libraryJsonPath = path.join(LIBRARY_ASSETS_DIR, 'assets.json');
        if (!fs.existsSync(libraryJsonPath)) {
            return res.json([]);
        }
        const libraryData = JSON.parse(fs.readFileSync(libraryJsonPath, 'utf8'));
        // Sort newest first
        libraryData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(libraryData);
    } catch (error) {
        console.error("List library error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete library asset
app.delete('/api/library/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const libraryJsonPath = path.join(LIBRARY_ASSETS_DIR, 'assets.json');

        if (!fs.existsSync(libraryJsonPath)) {
            return res.status(404).json({ error: "Library not found" });
        }

        let libraryData = JSON.parse(fs.readFileSync(libraryJsonPath, 'utf8'));
        const assetIndex = libraryData.findIndex(a => a.id === id);

        if (assetIndex === -1) {
            return res.status(404).json({ error: "Asset not found" });
        }

        const asset = libraryData[assetIndex];

        // Delete the actual file if it exists in our assets folder
        // asset.url usually looks like /library/assets/Category/file.ext
        if (asset.url && asset.url.startsWith('/library/assets/')) {
            const relativePath = asset.url.replace('/library/assets/', '');
            const filePath = path.join(LIBRARY_ASSETS_DIR, relativePath);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // Remove from array
        libraryData.splice(assetIndex, 1);
        fs.writeFileSync(libraryJsonPath, JSON.stringify(libraryData, null, 2));

        res.json({ success: true });
    } catch (error) {
        console.error("Delete library asset error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Workflow API Routes ---

// Save/Update workflow
app.post('/api/workflows', async (req, res) => {
    try {
        const workflow = req.body;
        if (!workflow.id) {
            workflow.id = crypto.randomUUID();
        }
        workflow.updatedAt = new Date().toISOString();
        if (!workflow.createdAt) {
            workflow.createdAt = workflow.updatedAt;
        }


        const filePath = path.join(WORKFLOWS_DIR, `${workflow.id}.json`);

        // Preserve existing coverUrl if it exists
        if (fs.existsSync(filePath)) {
            try {
                const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (existingData.coverUrl) {
                    workflow.coverUrl = existingData.coverUrl;
                }
            } catch (readError) {
                console.warn("Could not read existing workflow to preserve cover:", readError);
            }
        }

        // Sanitize nodes: convert any base64 data to file URLs before saving
        if (workflow.nodes) {
            workflow.nodes = sanitizeWorkflowNodes(workflow.nodes);
        }

        fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));


        res.json({ success: true, id: workflow.id });
    } catch (error) {
        console.error("Save workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Public Workflows API (bundled examples) ---

// List public workflows (shipped with the repo in public/workflows/)
// Dynamically scans directory - no need to maintain index.json manually
app.get('/api/public-workflows', async (req, res) => {
    try {
        const publicWorkflowsDir = path.join(__dirname, '..', 'public', 'workflows');

        if (!fs.existsSync(publicWorkflowsDir)) {
            return res.json([]);
        }

        // Scan all .json files except index.json
        const files = fs.readdirSync(publicWorkflowsDir)
            .filter(f => f.endsWith('.json') && f !== 'index.json');

        const workflows = files.map(file => {
            try {
                const content = fs.readFileSync(path.join(publicWorkflowsDir, file), 'utf8');
                const workflow = JSON.parse(content);

                // Generate description from workflow content
                const nodeTypes = workflow.nodes?.reduce((acc, n) => {
                    acc[n.type] = (acc[n.type] || 0) + 1;
                    return acc;
                }, {}) || {};
                const typesSummary = Object.entries(nodeTypes)
                    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
                    .join(', ');
                const description = workflow.description ||
                    (typesSummary ? `Workflow with ${typesSummary}` : 'A public workflow template');

                return {
                    id: file.replace('.json', ''),
                    title: workflow.title || 'Untitled Workflow',
                    description,
                    nodeCount: workflow.nodes?.length || 0,
                    coverUrl: workflow.coverUrl || null
                };
            } catch (parseError) {
                console.warn(`Skipping invalid workflow file: ${file}`, parseError.message);
                return null;
            }
        }).filter(Boolean); // Remove any null entries from parse errors

        // Sort by title alphabetically
        workflows.sort((a, b) => a.title.localeCompare(b.title));

        res.json(workflows);
    } catch (error) {
        console.error("List public workflows error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Load specific public workflow
app.get('/api/public-workflows/:id', async (req, res) => {
    try {
        const publicWorkflowsDir = path.join(__dirname, '..', 'public', 'workflows');
        const filePath = path.join(publicWorkflowsDir, `${req.params.id}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Public workflow not found" });
        }

        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Load public workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- User Workflows API ---

// List all workflows
app.get('/api/workflows', async (req, res) => {
    try {
        const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
        const workflows = files.map(file => {
            const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
            const workflow = JSON.parse(content);
            return {
                id: workflow.id,
                title: workflow.title,
                createdAt: workflow.createdAt,
                updatedAt: workflow.updatedAt,
                nodeCount: workflow.nodes?.length || 0,
                coverUrl: workflow.coverUrl
            };
        });
        workflows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        res.json(workflows);
    } catch (error) {
        console.error("List workflows error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Load specific workflow
app.get('/api/workflows/:id', async (req, res) => {
    try {
        const filePath = path.join(WORKFLOWS_DIR, `${req.params.id}.json`);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Load workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete workflow
app.delete('/api/workflows/:id', async (req, res) => {
    try {
        const filePath = path.join(WORKFLOWS_DIR, `${req.params.id}.json`);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (error) {
        console.error("Delete workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Update workflow cover
app.put('/api/workflows/:id/cover', async (req, res) => {
    try {
        const { coverUrl } = req.body;
        const filePath = path.join(WORKFLOWS_DIR, `${req.params.id}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }

        const workflowData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        workflowData.coverUrl = coverUrl;
        fs.writeFileSync(filePath, JSON.stringify(workflowData, null, 2));

        res.json({ success: true, coverUrl });
    } catch (error) {
        console.error("Update cover error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// GEMINI IMAGE DESCRIPTION API
// ============================================================================

// Describe an image for prompt generation
app.post('/api/gemini/describe-image', async (req, res) => {
    try {
        const { imageUrl, prompt } = req.body;
        console.log(`[Gemini DescribeV2] Request received. imageUrl: ${imageUrl ? (imageUrl.length > 100 ? imageUrl.substring(0, 100) + '...' : imageUrl) : 'missing'}`);
        // DEBUG: Verify story context injection
        if (prompt) {
            console.log('[Gemini DescribeV2] Received Prompt:', prompt);
        }

        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL is required' });
        }

        // Handle base64 or file URL
        let imagePart;

        // Check if it's a data URL (base64)
        if (imageUrl.startsWith('data:')) {
            const matches = imageUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                imagePart = {
                    inlineData: {
                        data: matches[2],
                        mimeType: matches[1]
                    }
                };
            }
        }
        // Handle local file paths (e.g., /library/images/...)
        else {
            // Strip domain if present to get relative path
            let cleanUrl = imageUrl;
            try {
                if (imageUrl.startsWith('http')) {
                    const u = new URL(imageUrl);
                    cleanUrl = u.pathname;
                }
            } catch (e) {
                // ignore invalid url parse, treat as path
            }

            // CRITICAL: Strip query string (cache busting params like ?t=123)
            if (cleanUrl.includes('?')) {
                cleanUrl = cleanUrl.split('?')[0];
            }

            console.log(`[Gemini DescribeV2] Cleaned path: ${cleanUrl}`);

            if (cleanUrl.startsWith('/library/')) {
                // Need to read the file from disk
                // Convert URL path to system path
                let fullPath = '';

                if (cleanUrl.startsWith('/library/images/')) {
                    const relativePath = cleanUrl.replace('/library/images/', '');
                    fullPath = path.join(IMAGES_DIR, relativePath);
                } else if (cleanUrl.startsWith('/library/videos/')) {
                    return res.status(400).json({ error: 'Video description not directly supported, use a frame.' });
                }

                console.log(`[Gemini DescribeV2] Resolved path: ${fullPath}`);

                if (fullPath && fs.existsSync(fullPath)) {
                    const imageData = fs.readFileSync(fullPath);
                    const base64Data = imageData.toString('base64');
                    const mimeType = fullPath.endsWith('.png') ? 'image/png' :
                        fullPath.endsWith('.jpg') || fullPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp';

                    imagePart = {
                        inlineData: {
                            data: base64Data,
                            mimeType: mimeType
                        }
                    };
                } else {
                    console.log(`[Gemini DescribeV2] File not found at: ${fullPath}`);
                }
            }
        }

        if (!imagePart) {
            console.log('[Gemini DescribeV2] Failed to process image part');
            return res.status(400).json({ error: 'Could not process image URL. Provide base64 data or a valid library path.', debug: { imageUrl } });
        }

        const client = getClient();
        // Correct SDK usage for @google/genai ^1.32.0
        const result = await client.models.generateContent({
            model: "gemini-2.0-flash",
            contents: {
                parts: [
                    { text: prompt || "Describe this image in detail for video generation." },
                    imagePart
                ]
            }
        });

        let text = "";

        // Handle @google/genai SDK response structure
        if (result.candidates && result.candidates.length > 0) {
            const candidate = result.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                text = candidate.content.parts[0].text || "";
            }
        }
        // Fallback for other potential response shapes
        else if (result.response && typeof result.response.text === 'function') {
            text = result.response.text();
        }

        if (!text) {
            console.warn('[Gemini DescribeV2] Warning: No text content found in response.');
            console.debug('[Gemini DescribeV2] Response dump:', JSON.stringify(result, null, 2));
        }

        res.json({ description: text });

    } catch (error) {
        console.error("Describe image error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Optimize a prompt for video generation
app.post('/api/gemini/optimize-prompt', async (req, res) => {
    try {
        const { prompt } = req.body;
        console.log(`[Gemini Optimize] Request received. Prompt: ${prompt ? (prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt) : 'missing'}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const client = getClient();
        const systemInstruction = "You are an expert video prompt engineer. Your goal is to rewrite the user's prompt to be descriptive, visual, and optimized for AI video generation models like Veo, Kling, and Hailuo. detailed, cinematic, and focused on motion and atmosphere. Keep it under 60 words. Output ONLY the rewritten prompt.";

        const result = await client.models.generateContent({
            model: "gemini-2.0-flash",
            contents: {
                parts: [
                    { text: `${systemInstruction}\n\nUser Prompt: ${prompt}` }
                ]
            }
        });

        let text = "";

        // Handle @google/genai SDK response structure
        if (result.candidates && result.candidates.length > 0) {
            const candidate = result.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                text = candidate.content.parts[0].text || "";
            }
        }
        // Fallback for other potential response shapes
        else if (result.response && typeof result.response.text === 'function') {
            text = result.response.text();
        }

        if (!text) {
            console.warn('[Gemini Optimize] Warning: No text content found in response.');
            return res.status(500).json({ error: 'Failed to optimize prompt' });
        }

        // Clean up text (remove quotes if present)
        text = text.trim().replace(/^["']|["']$/g, '');

        res.json({ optimizedPrompt: text });

    } catch (error) {
        console.error("Optimize prompt error:", error);
        res.status(500).json({ error: error.message });
    }
});

// NOTE: Old generation routes removed - now in server/routes/generation.js


// ============================================================================
// ASSET HISTORY API
// ============================================================================

// Save an asset (image or video)
app.post('/api/assets/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { data, prompt } = req.body;

        if (!['images', 'videos'].includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = type === 'images' ? IMAGES_DIR : VIDEOS_DIR;
        // 防止连续快速上传时时间戳撞号覆盖文件
        let idNum = Date.now();
        while (fs.existsSync(path.join(targetDir, `${idNum}.json`))) idNum++;
        const id = idNum.toString();
        const ext = type === 'images' ? 'png' : 'mp4';
        const filename = `${id}.${ext}`;
        const metaFilename = `${id}.json`;

        // Save the asset file
        const base64Data = data.replace(/^data:[^;]+;base64,/, '');
        fs.writeFileSync(path.join(targetDir, filename), base64Data, 'base64');

        // Save metadata
        const metadata = {
            id,
            filename,
            prompt: prompt || '',
            createdAt: new Date().toISOString(),
            type
        };
        fs.writeFileSync(path.join(targetDir, metaFilename), JSON.stringify(metadata, null, 2));

        res.json({ success: true, id, filename, url: `/library/${type}/${filename}` });
    } catch (error) {
        console.error('Save asset error:', error);
        res.status(500).json({ error: error.message });
    }
});

// List all assets of a type (with pagination support)
app.get('/api/assets/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const limit = parseInt(req.query.limit) || 0; // 0 = no limit (backward compatible)
        const offset = parseInt(req.query.offset) || 0;

        if (!['images', 'videos'].includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = type === 'images' ? IMAGES_DIR : VIDEOS_DIR;

        if (!fs.existsSync(targetDir)) {
            // Return paginated format if limit is specified, otherwise array for backward compatibility
            return res.json(limit > 0 ? { assets: [], total: 0, hasMore: false } : []);
        }

        const files = fs.readdirSync(targetDir);
        const assets = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const content = fs.readFileSync(path.join(targetDir, file), 'utf8');
                    const metadata = JSON.parse(content);
                    metadata.url = `/library/${type}/${metadata.filename}`;
                    assets.push(metadata);
                } catch (e) {
                    // Skip invalid JSON files
                }
            }
        }

        // Sort by createdAt descending (newest first)
        assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        // If limit is specified, return paginated response
        if (limit > 0) {
            const paginatedAssets = assets.slice(offset, offset + limit);
            return res.json({
                assets: paginatedAssets,
                total: assets.length,
                hasMore: offset + limit < assets.length
            });
        }

        // Backward compatible: return full array if no limit specified
        res.json(assets);
    } catch (error) {
        console.error('List assets error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete an asset
app.delete('/api/assets/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;

        if (!['images', 'videos'].includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = type === 'images' ? IMAGES_DIR : VIDEOS_DIR;
        const metaPath = path.join(targetDir, `${id}.json`);

        // Read metadata to get the actual filename (may differ from ID)
        let assetFilename = null;
        if (fs.existsSync(metaPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                assetFilename = metadata.filename;
            } catch (e) {
                console.warn(`Could not read metadata for ${id}:`, e.message);
            }
        }

        // Delete the media file using filename from metadata
        if (assetFilename) {
            const assetPath = path.join(targetDir, assetFilename);
            if (fs.existsSync(assetPath)) {
                fs.unlinkSync(assetPath);
                console.log(`Deleted asset file: ${assetPath}`);
            }
        }

        // Delete the metadata file
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
            console.log(`Deleted metadata file: ${metaPath}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete asset error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 批量清理历史素材：body.olderThanDays = N 清理 N 天前的；不传则清空全部
app.post('/api/assets/:type/clean', async (req, res) => {
    try {
        const { type } = req.params;
        const { olderThanDays } = req.body || {};

        if (!['images', 'videos'].includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = type === 'images' ? IMAGES_DIR : VIDEOS_DIR;
        if (!fs.existsSync(targetDir)) {
            return res.json({ success: true, deleted: 0 });
        }

        const days = Number(olderThanDays);
        const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : null;
        let deleted = 0;

        for (const file of fs.readdirSync(targetDir)) {
            if (!file.endsWith('.json')) continue;
            const metaPath = path.join(targetDir, file);
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (cutoff) {
                    const created = new Date(meta.createdAt).getTime();
                    // createdAt 无效或晚于截止时间的保留（NaN 比较为 false，自动保留）
                    if (!(created < cutoff)) continue;
                }
                if (meta.filename) {
                    const assetPath = path.join(targetDir, meta.filename);
                    if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
                }
                fs.unlinkSync(metaPath);
                deleted++;
            } catch (e) {
                console.warn(`[Clean] Skip ${file}:`, e.message);
            }
        }

        console.log(`[Clean] ${type}: deleted ${deleted} assets (olderThanDays=${olderThanDays ?? 'all'})`);
        res.json({ success: true, deleted });
    } catch (error) {
        console.error('Clean assets error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// 剪辑项目：保存/加载视频剪辑工作区状态（时间轴、字幕、配音等）
// ============================================================================

const sanitizeProjectId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

// 列出全部剪辑项目（仅元信息，按更新时间倒序）
app.get('/api/edit-projects', (req, res) => {
    try {
        const list = [];
        for (const file of fs.readdirSync(EDIT_PROJECTS_DIR)) {
            if (!file.endsWith('.json')) continue;
            try {
                const p = JSON.parse(fs.readFileSync(path.join(EDIT_PROJECTS_DIR, file), 'utf8'));
                list.push({
                    id: p.id,
                    name: p.name,
                    createdAt: p.createdAt,
                    updatedAt: p.updatedAt,
                    clipCount: Array.isArray(p.data?.clips) ? p.data.clips.length : 0,
                });
            } catch { /* 跳过损坏文件 */ }
        }
        list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        res.json({ projects: list });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 获取单个剪辑项目（含完整数据）
app.get('/api/edit-projects/:id', (req, res) => {
    try {
        const id = sanitizeProjectId(req.params.id);
        const file = path.join(EDIT_PROJECTS_DIR, `${id}.json`);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Project not found' });
        res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 保存剪辑项目：传 id 则覆盖更新，不传则新建
app.post('/api/edit-projects', (req, res) => {
    try {
        const { id, name, data } = req.body || {};
        if (!data || typeof data !== 'object') {
            return res.status(400).json({ error: 'Missing project data' });
        }
        const projectId = sanitizeProjectId(id) || `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const file = path.join(EDIT_PROJECTS_DIR, `${projectId}.json`);
        const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        const now = new Date().toISOString();
        const project = {
            id: projectId,
            name: String(name || existing?.name || '未命名剪辑').slice(0, 80),
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            data,
        };
        fs.writeFileSync(file, JSON.stringify(project));
        res.json({ success: true, id: projectId, name: project.name, updatedAt: now });
    } catch (error) {
        console.error('Save edit project error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 删除剪辑项目
app.delete('/api/edit-projects/:id', (req, res) => {
    try {
        const id = sanitizeProjectId(req.params.id);
        const file = path.join(EDIT_PROJECTS_DIR, `${id}.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// VIDEO TRIM API
// ============================================================================

/**
 * Check if FFmpeg is available on the system
 */
async function isFFmpegAvailable() {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

/**
 * Trim a video using FFmpeg
 * @param {string} inputPath - Input video path
 * @param {string} outputPath - Output video path
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 */
async function trimVideoWithFFmpeg(inputPath, outputPath, startTime, endTime) {
    return new Promise((resolve, reject) => {
        const duration = endTime - startTime;

        if (duration <= 0) {
            reject(new Error('Invalid trim range: end time must be greater than start time'));
            return;
        }

        const args = [
            '-y',                           // Overwrite output
            '-i', inputPath,                // Input file
            '-ss', startTime.toString(),    // Start time
            '-t', duration.toString(),      // Duration
            '-c:v', 'libx264',              // Video codec
            '-c:a', 'aac',                  // Audio codec
            '-preset', 'fast',              // Encoding speed
            '-crf', '23',                   // Quality (lower = better)
            outputPath                       // Output file
        ];

        console.log(`[Video Trim] Running FFmpeg with args:`, args.join(' '));

        const proc = spawn('ffmpeg', args, { shell: true });

        let stderr = '';
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`[Video Trim] Successfully trimmed video`);
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`FFmpeg error: ${err.message}`));
        });
    });
}

/**
 * Trim a video and save to library
 * Accepts video URL (from library), start/end times, and saves trimmed video
 */
app.post('/api/trim-video', async (req, res) => {
    try {
        const { videoUrl, startTime, endTime, nodeId } = req.body;

        if (!videoUrl || startTime === undefined || endTime === undefined) {
            return res.status(400).json({ error: 'videoUrl, startTime, and endTime are required' });
        }

        console.log(`[Video Trim] Request: ${videoUrl}, ${startTime}s to ${endTime}s`);

        // Check if FFmpeg is available
        const ffmpegAvailable = await isFFmpegAvailable();
        if (!ffmpegAvailable) {
            return res.status(500).json({
                error: 'FFmpeg is not installed. Video trimming requires FFmpeg to be installed on the server.'
            });
        }

        // Strip query string from URL (e.g., ?t=123456 cache busters)
        const cleanVideoUrl = videoUrl.split('?')[0];

        // Resolve video path from URL
        let inputPath;
        if (cleanVideoUrl.startsWith('/library/videos/')) {
            inputPath = path.join(VIDEOS_DIR, cleanVideoUrl.replace('/library/videos/', ''));
        } else if (cleanVideoUrl.startsWith('http')) {
            // For remote URLs, we'd need to download first - for now, only local library videos
            return res.status(400).json({ error: 'Only local library videos can be trimmed' });
        } else {
            return res.status(400).json({ error: 'Invalid video URL format' });
        }

        // Check if input file exists
        if (!fs.existsSync(inputPath)) {
            console.error(`[Video Trim] Input file not found: ${inputPath}`);
            return res.status(404).json({ error: 'Source video not found' });
        }

        // Generate unique output filename
        const timestamp = Date.now();
        const hash = crypto.randomBytes(4).toString('hex');
        const outputFilename = `trimmed_${timestamp}_${hash}.mp4`;
        const outputPath = path.join(VIDEOS_DIR, outputFilename);

        // Trim the video
        await trimVideoWithFFmpeg(inputPath, outputPath, startTime, endTime);

        // Save metadata for history panel
        const id = `${timestamp}_${hash}`;
        const metaFilename = `${id}.json`;
        const metadata = {
            id,
            filename: outputFilename,
            prompt: `Trimmed video (${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s)`,
            model: 'video-editor',
            sourceUrl: videoUrl,
            trimStart: startTime,
            trimEnd: endTime,
            createdAt: new Date().toISOString(),
            type: 'videos'
        };
        fs.writeFileSync(path.join(VIDEOS_DIR, metaFilename), JSON.stringify(metadata, null, 2));

        const resultUrl = `/library/videos/${outputFilename}`;
        console.log(`[Video Trim] Saved: ${resultUrl}`);

        res.json({
            success: true,
            url: resultUrl,
            filename: outputFilename,
            duration: endTime - startTime
        });

    } catch (error) {
        console.error('[Video Trim] Error:', error);
        res.status(500).json({
            error: error.message || 'Failed to trim video',
            details: error.toString()
        });
    }
});

// ============================================================================
// CHAT AGENT API
// NOTE: Currently using LangGraph.js. If more complex agent capabilities
// are needed (multi-agent, advanced tools), consider migrating to Python.
// ============================================================================

// Send a message to the chat agent
// 聊天（SSE 流式）：模型生成的文字逐段推送，避免长回复时前端一直转圈。
// 事件：{type:'delta', text} 增量 → {type:'done', response, topic, messageCount} → 可选 {type:'topic', topic}
app.post('/api/chat', async (req, res) => {
    const { sessionId, message, media } = req.body;

    const API_KEY = getKey('TEXT_API_KEY');
    if (!API_KEY) {
        return res.status(500).json({ error: "未配置文字模型 KEY，请在「设置」中填写后再使用聊天" });
    }
    if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required" });
    }
    if (!message && !media) {
        return res.status(400).json({ error: "message or media is required" });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端可能已断开 */ } };

    try {
        let sentLen = 0;
        const result = await chatAgent.sendMessage(sessionId, message, media, API_KEY, (delta, total) => {
            // gpt2apiChat 的 onDelta 给的是增量片段；直接推增量
            if (delta) { sentLen = total; send({ type: 'delta', text: delta }); }
        });

        send({
            type: 'done',
            response: result.response,
            topic: result.topic,
            messageCount: result.messageCount,
        });

        // 首轮对话的标题在后台生成，生成完再补发一个事件（不阻塞回复展示）
        if (result.topicPromise) {
            const topic = await result.topicPromise;
            send({ type: 'topic', topic });
        }
        res.end();
    } catch (error) {
        console.error("Chat API Error:", error);
        send({ type: 'error', error: error.message || "Chat failed" });
        res.end();
    }
});

// List all chat sessions
app.get('/api/chat/sessions', async (req, res) => {
    try {
        const sessions = chatAgent.listSessions();
        res.json(sessions);
    } catch (error) {
        console.error("List sessions error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a chat session
app.delete('/api/chat/sessions/:id', async (req, res) => {
    try {
        chatAgent.deleteSession(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error("Delete session error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Get full session data (for loading a specific chat)
app.get('/api/chat/sessions/:id', async (req, res) => {
    try {
        const sessionData = chatAgent.getSessionData(req.params.id);
        if (!sessionData) {
            return res.status(404).json({ error: "Session not found" });
        }
        res.json(sessionData);
    } catch (error) {
        console.error("Get session error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '..', 'dist');
    app.use(express.static(distPath));

    // Handle SPA routing: serve index.html for any non-API GET request.
    // (Express 5 / path-to-regexp v8 no longer accepts the bare '*' path.)
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        if (req.path.startsWith('/api') || req.path.startsWith('/library')) return next();
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
