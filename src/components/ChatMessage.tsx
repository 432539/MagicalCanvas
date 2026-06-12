/**
 * ChatMessage.tsx
 * 
 * Reusable message bubble component for the chat panel.
 * Displays user and assistant messages with multiple media support.
 * Renders code blocks with copy functionality.
 */

import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ============================================================================
// TYPES
// ============================================================================

interface ChatMessageProps {
    role: 'user' | 'assistant';
    content: string;
    media?: {
        type: 'image' | 'video';
        url: string;
    }[];
    timestamp?: Date;
}

interface CodeBlockProps {
    code: string;
}

// ============================================================================
// CODE BLOCK COMPONENT
// ============================================================================

/**
 * Renders a code block with a copy button
 */
const CodeBlock: React.FC<CodeBlockProps> = ({ code }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <div className="relative my-2 group">
            <pre className="bg-neutral-900 border border-neutral-700 rounded-lg p-3 text-sm overflow-x-auto">
                <code className="text-cyan-300 whitespace-pre-wrap break-words">{code}</code>
            </pre>
            <button
                onClick={handleCopy}
                className="absolute top-2 right-2 p-1.5 bg-neutral-700 hover:bg-neutral-600 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                title={copied ? 'Copied!' : 'Copy to clipboard'}
            >
                {copied ? (
                    <Check size={14} className="text-green-400" />
                ) : (
                    <Copy size={14} className="text-neutral-300" />
                )}
            </button>
        </div>
    );
};

// ============================================================================
// CONTENT PARSER
// ============================================================================

/**
 * Parses message content and extracts code blocks
 * Returns an array of content segments (text or code)
 */
function parseContent(content: string): Array<{ type: 'text' | 'code'; content: string }> {
    const segments: Array<{ type: 'text' | 'code'; content: string }> = [];

    // Regex to match code blocks (```...``` or ```language\n...```)
    const codeBlockRegex = /```(?:\w+)?\n?([\s\S]*?)```/g;

    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
        // Add text before the code block
        if (match.index > lastIndex) {
            const text = content.slice(lastIndex, match.index).trim();
            if (text) {
                segments.push({ type: 'text', content: text });
            }
        }

        // Add the code block
        segments.push({ type: 'code', content: match[1].trim() });
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last code block
    if (lastIndex < content.length) {
        const text = content.slice(lastIndex).trim();
        if (text) {
            segments.push({ type: 'text', content: text });
        }
    }

    // If no code blocks found, return the entire content as text
    if (segments.length === 0) {
        segments.push({ type: 'text', content: content });
    }

    return segments;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ChatMessage: React.FC<ChatMessageProps> = ({
    role,
    content,
    media,
    timestamp
}) => {
    const isUser = role === 'user';

    // Clean content and parse code blocks
    const cleanedContent = content.replace(/\[IMAGE \d+ ATTACHED\]/g, '').trim();
    const segments = parseContent(cleanedContent);

    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
            <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${isUser
                    ? 'bg-cyan-600 text-white rounded-br-md'
                    : 'bg-neutral-800 text-neutral-100 rounded-bl-md'
                    }`}
            >
                {/* Media Attachments */}
                {media && media.length > 0 && (
                    <div className={`mb-2 ${media.length > 1 ? 'grid grid-cols-2 gap-2' : ''}`}>
                        {media.map((m, index) => (
                            <div key={index} className="relative">
                                {m.type === 'image' ? (
                                    <img
                                        src={m.url}
                                        alt={`Attached ${index + 1}`}
                                        className="w-full max-h-32 rounded-lg object-cover"
                                    />
                                ) : (
                                    <video
                                        src={m.url}
                                        className="w-full max-h-32 rounded-lg object-cover"
                                        controls
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Message Content: 围栏代码块用带复制按钮的 CodeBlock，其余文本走 Markdown 渲染 */}
                <div className="text-sm leading-relaxed select-text cursor-text">
                    {segments.map((segment, index) => (
                        segment.type === 'code' ? (
                            <CodeBlock key={index} code={segment.content} />
                        ) : (
                            <ReactMarkdown
                                key={index}
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
                                    strong: ({ children }) => <strong className={`font-semibold ${isUser ? 'text-white' : 'text-cyan-300'}`}>{children}</strong>,
                                    em: ({ children }) => <em className="italic">{children}</em>,
                                    ul: ({ children }) => <ul className="my-1.5 pl-5 list-disc space-y-1">{children}</ul>,
                                    ol: ({ children }) => <ol className="my-1.5 pl-5 list-decimal space-y-1">{children}</ol>,
                                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                    h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1.5">{children}</h1>,
                                    h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1.5">{children}</h2>,
                                    h3: ({ children }) => <h3 className="text-sm font-bold mt-2.5 mb-1">{children}</h3>,
                                    h4: ({ children }) => <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>,
                                    a: ({ href, children }) => (
                                        <a href={href} target="_blank" rel="noopener noreferrer" className={`underline ${isUser ? 'text-cyan-100' : 'text-cyan-400 hover:text-cyan-300'}`}>{children}</a>
                                    ),
                                    blockquote: ({ children }) => (
                                        <blockquote className={`border-l-2 pl-3 my-1.5 ${isUser ? 'border-cyan-300/60 text-cyan-50' : 'border-neutral-600 text-neutral-400'}`}>{children}</blockquote>
                                    ),
                                    code: ({ children }) => (
                                        <code className={`px-1 py-0.5 rounded text-[12px] ${isUser ? 'bg-cyan-700/70 text-cyan-50' : 'bg-neutral-900 text-cyan-300'}`}>{children}</code>
                                    ),
                                    hr: () => <hr className={`my-2 ${isUser ? 'border-cyan-400/40' : 'border-neutral-700'}`} />,
                                    table: ({ children }) => (
                                        <div className="overflow-x-auto my-2">
                                            <table className="text-xs border-collapse">{children}</table>
                                        </div>
                                    ),
                                    th: ({ children }) => <th className={`border px-2 py-1 text-left font-semibold ${isUser ? 'border-cyan-400/40' : 'border-neutral-700 bg-neutral-900'}`}>{children}</th>,
                                    td: ({ children }) => <td className={`border px-2 py-1 ${isUser ? 'border-cyan-400/40' : 'border-neutral-700'}`}>{children}</td>,
                                }}
                            >
                                {segment.content}
                            </ReactMarkdown>
                        )
                    ))}
                </div>

                {/* Timestamp (optional) */}
                {timestamp && (
                    <div
                        className={`text-[10px] mt-1 ${isUser ? 'text-cyan-200' : 'text-neutral-500'
                            }`}
                    >
                        {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ChatMessage;
