/**
 * agent/index.js
 * 
 * Main entry point for the LangGraph chat agent.
 * Exports the compiled graph and utility functions.
 * 
 * NOTE: Currently implemented in JavaScript/LangGraph.js for simplicity.
 * If more advanced agent capabilities are needed (complex tool chains,
 * multi-agent systems, advanced memory), consider migrating to Python
 * LangGraph which has a more mature and feature-rich ecosystem.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { getKey } from "../config.js";
import { gpt2apiChat } from "../services/gpt2api.js";
import { CHAT_AGENT_SYSTEM_PROMPT, TOPIC_GENERATION_PROMPT } from "./prompts/system.js";

// 读取 gpt2api 文本配置
function getTextConfig() {
    return {
        apiKey: getKey('TEXT_API_KEY'),
        baseUrl: getKey('TEXT_API_URL'),
        model: getKey('TEXT_MODEL') || 'grok-4.20-fast',
    };
}

/** 将会话内的 LangChain 消息转换为 OpenAI 兼容消息 */
function toOpenAIMessages(messages) {
    const out = [{ role: 'system', content: CHAT_AGENT_SYSTEM_PROMPT }];
    for (const m of messages) {
        const role = m._getType?.() === 'human' ? 'user' : 'assistant';
        out.push({ role, content: m.content });
    }
    return out;
}

/** 基于会话生成简短主题标题（使用 gpt2api 文本模型） */
export async function generateTopicTitle(messages) {
    const { apiKey, baseUrl, model } = getTextConfig();
    if (!apiKey) return 'New Chat';

    // 仅取首条用户文本作为生成依据，避免发送图片
    const firstUser = messages.find(m => m._getType?.() === 'human');
    const userText = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : '用户分享了图片/视频') : '';

    const oaMessages = [
        { role: 'system', content: TOPIC_GENERATION_PROMPT },
        { role: 'user', content: userText || 'New conversation' },
    ];
    // maxTokens 不能太小：思考型模型（gpt-5 系）会先消耗推理 token，给太少会导致正文为空
    const title = await gpt2apiChat({ messages: oaMessages, model, baseUrl, apiKey, temperature: 0.3, maxTokens: 1024 });
    return (title || 'New Chat').trim().replace(/^["']|["']$/g, '').slice(0, 40) || 'New Chat';
}

// ============================================================================
// FILE PATHS
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHATS_DIR = path.join(__dirname, '..', '..', 'library', 'chats');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'library', 'images');

// Ensure chats directory exists
if (!fs.existsSync(CHATS_DIR)) {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
}

/**
 * Resolve an image URL or base64 to a base64 data URL
 * Handles both file paths (/library/images/...) and data URLs
 */
function resolveImageToBase64(imageInput) {
    if (!imageInput) return null;

    // Already a base64 data URL
    if (imageInput.startsWith('data:')) {
        return imageInput;
    }

    // Handle full URL or path
    let cleanPath = imageInput;
    try {
        if (imageInput.startsWith('http')) {
            const u = new URL(imageInput);
            cleanPath = u.pathname;
        }
    } catch (e) {
        // invalid url, treat as path
    }

    // Decode URI components (e.g., %20 -> space)
    cleanPath = decodeURIComponent(cleanPath);

    // File URL - read from disk
    if (cleanPath.startsWith('/library/images/')) {
        const filename = cleanPath.replace('/library/images/', '');
        const filePath = path.join(IMAGES_DIR, filename);
        if (fs.existsSync(filePath)) {
            const buffer = fs.readFileSync(filePath);
            const ext = path.extname(filename).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
            return `data:${mimeType};base64,${buffer.toString('base64')}`;
        }
    }

    // Return as-is if unknown format
    return imageInput;
}

// ============================================================================
// SESSION MANAGEMENT (FILE-BASED)
// ============================================================================

/**
 * In-memory cache for active sessions
 * Sessions are also persisted to disk after each message
 */
const sessionCache = new Map();

/**
 * Convert multimodal content to text representation for serialization
 * This ensures context is preserved without huge base64 data
 */
function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        const parts = [];
        let imageCount = 0;

        for (const part of content) {
            if (part.type === 'text') {
                parts.push(part.text);
            } else if (part.type === 'image_url') {
                imageCount++;
                parts.push(`[IMAGE ${imageCount} ATTACHED]`);
            }
        }

        return parts.join('\n');
    }

    return JSON.stringify(content);
}

/**
 * Convert LangChain messages to serializable format
 * Multimodal messages are converted to text with [IMAGE ATTACHED] markers
 */
function serializeMessages(messages) {
    return messages.map(msg => ({
        role: msg._getType?.() === 'human' ? 'user' : 'assistant',
        content: contentToText(msg.content),
        media: msg.additional_kwargs?.media,
        timestamp: new Date().toISOString()
    }));
}

/**
 * Convert serialized messages back to LangChain format
 * All messages are now stored as text (images converted to markers)
 */
function deserializeMessages(messages) {
    return messages.map(msg => {
        if (msg.role === 'user') {
            const message = new HumanMessage(msg.content);
            if (msg.media) {
                message.additional_kwargs = { media: msg.media };
            }
            return message;
        } else {
            return new AIMessage(msg.content);
        }
    });
}

/**
 * Get the file path for a session
 */
function getSessionPath(sessionId) {
    return path.join(CHATS_DIR, `${sessionId}.json`);
}

/**
 * Save a session to disk
 */
function saveSession(sessionId, session) {
    const filePath = getSessionPath(sessionId);
    const data = {
        id: sessionId,
        topic: session.topic,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
        messages: serializeMessages(session.messages)
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Load a session from disk
 */
function loadSession(sessionId) {
    const filePath = getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        return {
            messages: deserializeMessages(data.messages),
            topic: data.topic,
            createdAt: new Date(data.createdAt)
        };
    } catch (err) {
        console.error(`Failed to load session ${sessionId}:`, err);
        return null;
    }
}

/**
 * Get or create a chat session
 * @param {string} sessionId - Unique session identifier
 * @returns {object} Session object
 */
export function getSession(sessionId) {
    // Check cache first
    if (sessionCache.has(sessionId)) {
        return sessionCache.get(sessionId);
    }

    // Try to load from disk
    const loaded = loadSession(sessionId);
    if (loaded) {
        sessionCache.set(sessionId, loaded);
        return loaded;
    }

    // Create new session
    const newSession = {
        messages: [],
        topic: null,
        createdAt: new Date(),
    };
    sessionCache.set(sessionId, newSession);
    return newSession;
}

/**
 * Delete a chat session
 * @param {string} sessionId - Session to delete
 * @returns {boolean} Whether session existed and was deleted
 */
export function deleteSession(sessionId) {
    sessionCache.delete(sessionId);

    const filePath = getSessionPath(sessionId);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

/**
 * List all sessions from disk (for chat history)
 * @returns {Array} Array of session summaries
 */
export function listSessions() {
    if (!fs.existsSync(CHATS_DIR)) {
        return [];
    }

    const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
        try {
            const filePath = path.join(CHATS_DIR, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            sessions.push({
                id: data.id,
                topic: data.topic || "New Chat",
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                messageCount: data.messages?.length || 0
            });
        } catch (err) {
            console.error(`Failed to read session file ${file}:`, err);
        }
    }

    // Sort by most recent first
    return sessions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

/**
 * Get full session data (for loading a specific chat)
 * @param {string} sessionId - Session ID
 * @returns {object|null} Full session data with messages
 */
export function getSessionData(sessionId) {
    const filePath = getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`Failed to load session data ${sessionId}:`, err);
        return null;
    }
}

// ============================================================================
// CHAT FUNCTIONS
// ============================================================================

/**
 * Send a message to the chat agent and get a response
 * @param {string} sessionId - Session identifier
 * @param {string} content - User message content
 * @param {Array} media - Optional media attachments [{ type, url, base64 }, ...]
 * @param {string} apiKey - Google AI API key
 * @returns {Promise<object>} { response: string, topic?: string }
 */
export async function sendMessage(sessionId, content, media, apiKey, onDelta) {
    const session = getSession(sessionId);
    const { apiKey: gptKey, baseUrl, model } = getTextConfig();

    // Debug: Log session state
    console.log(`[Chat] Session ${sessionId} has ${session.messages.length} existing messages`);

    // Build the user message content
    let messageContent;
    if (media && Array.isArray(media) && media.length > 0) {
        // Multimodal message with images/videos
        const contentParts = [{ type: "text", text: content || "What do you see in these images?" }];

        for (const m of media) {
            // Resolve file URLs to base64 if needed
            const resolvedBase64 = resolveImageToBase64(m.base64);
            if (!resolvedBase64) continue;

            const mimeType = m.type === 'video' ? 'video/mp4' : 'image/png';
            // Extract base64 data if it's a data URL
            const base64Data = resolvedBase64.includes(',')
                ? resolvedBase64.split(',')[1]
                : resolvedBase64;

            contentParts.push({
                type: "image_url",
                image_url: {
                    url: `data:${mimeType};base64,${base64Data}`,
                },
            });
        }

        messageContent = contentParts;
    } else {
        messageContent = content;
    }

    // Debug logging


    // Add user message to session
    const userMessage = new HumanMessage(messageContent);

    // Attach metadata for persistence (excluding base64 to save space)
    if (media && Array.isArray(media)) {
        userMessage.additional_kwargs = {
            ...userMessage.additional_kwargs,
            media: media.map(m => {
                // If base64 field contains a URL, preserve it as url
                let url = m.url;
                const b64 = m.base64;
                if (!url && b64 && !b64.startsWith('data:')) {
                    url = b64;
                }
                return { ...m, url, base64: undefined };
            })
        };
    }

    session.messages.push(userMessage);

    console.log(`[Chat] Sending ${session.messages.length} messages to gpt2api (${model})`);

    // Call gpt2api (OpenAI-compatible chat completions)
    const oaMessages = toOpenAIMessages(session.messages);
    const responseText = await gpt2apiChat({ messages: oaMessages, model, baseUrl, apiKey: gptKey, onDelta });
    const aiResponse = new AIMessage(responseText || '');
    session.messages.push(aiResponse);

    // Convert the multimodal user message to text for future context
    // This ensures the AI remembers what images contained in subsequent turns
    if (typeof messageContent !== 'string') {
        const textVersion = contentToText(messageContent);
        // Replace the last user message with text version but keep metadata
        const userMsgIndex = session.messages.length - 2;
        const originalMsg = session.messages[userMsgIndex];

        const newMsg = new HumanMessage(textVersion);
        if (originalMsg.additional_kwargs) {
            newMsg.additional_kwargs = originalMsg.additional_kwargs;
        }
        session.messages[userMsgIndex] = newMsg;

        session.messages[userMsgIndex] = newMsg;
    }

    // Generate topic if this is the first exchange (2 messages: user + AI).
    // 不阻塞主回复：标题在后台生成，调用方可在回复送达后再等它（流式场景下避免多等一轮 LLM）。
    let topic = session.topic;
    let topicPromise = null;
    if (session.messages.length === 2 && !session.topic) {
        topicPromise = generateTopicTitle(session.messages)
            .then(t => {
                session.topic = t;
                saveSession(sessionId, session);
                return t;
            })
            .catch(err => {
                console.error("Failed to generate topic:", err);
                return "New Chat";
            });
    }

    // Save session to disk after each message
    saveSession(sessionId, session);

    return {
        response: aiResponse.content.toString(),
        topic: topic,
        topicPromise,
        messageCount: session.messages.length,
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    getSession,
    deleteSession,
    listSessions,
    getSessionData,
    sendMessage,
    generateTopicTitle,
};
