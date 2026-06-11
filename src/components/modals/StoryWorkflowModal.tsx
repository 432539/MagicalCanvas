/**
 * StoryWorkflowModal - 一键创建工作流
 *
 * 输入小说/剧本 + 时长 + 风格，调用文字 AI 分析，
 * 自动生成：人物/场景/道具资产节点 + 分镜图片节点 + 视频节点 + 连线。
 */

import React, { useRef, useState } from 'react';
import { X, Wand2, Upload, Loader2, BookOpen, Clock, Palette, Clapperboard, Zap, Monitor } from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

export interface StoryAsset {
    name: string;
    desc: string;
    prompt: string;
}

export interface StoryShot {
    index: number;
    description: string;
    characters: string[];
    scene: string;
    props: string[];
    imagePrompt: string;
    videoPrompt: string;
    duration: number;
    dialogue: string;
}

export interface StoryWorkflowResult {
    title: string;
    summary: string;
    styleAnchor: string;
    characters: StoryAsset[];
    scenes: StoryAsset[];
    props: StoryAsset[];
    shots: StoryShot[];
}

interface StoryWorkflowModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (result: StoryWorkflowResult, opts: { autoGenerate: boolean; aspectRatio: string }) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STYLE_PRESETS: { label: string; anchor: string }[] = [
    { label: '国风二次元', anchor: '国风二次元，新国潮美学，日式动画渲染，赛璐璐平涂，细腻线条，电影质感' },
    { label: '写实电影', anchor: '写实电影风格，photorealistic, cinematic lighting, 35mm film, 胶片质感，电影构图' },
    { label: '3D 动画', anchor: '3D 动画风格，Pixar style rendering, 柔和全局光照，高细节材质，圆润造型' },
    { label: '日漫风', anchor: '日式动漫风格，anime style, cel shading, 鲜明色彩，干净线条' },
    { label: '水墨国风', anchor: '中国水墨画风格，写意笔触，留白构图，淡彩晕染，东方美学' },
    { label: '赛博朋克', anchor: '赛博朋克风格，霓虹光效，高对比明暗，未来都市，冷暖撞色' },
];

const DURATION_OPTIONS = [4, 6, 8, 10, 12, 15];
const SHOT_COUNT_OPTIONS = [6, 9, 12, 15, 20];
const RATIO_OPTIONS: { value: string; label: string }[] = [
    { value: '16:9', label: '16:9 横屏' },
    { value: '9:16', label: '9:16 竖屏' },
];

// ============================================================================
// COMPONENT
// ============================================================================

export const StoryWorkflowModal: React.FC<StoryWorkflowModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [script, setScript] = useState('');
    const [shotDuration, setShotDuration] = useState(6);
    const [maxShots, setMaxShots] = useState(12);
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [styleIdx, setStyleIdx] = useState<number | null>(0);
    const [customStyle, setCustomStyle] = useState('');
    const [autoGenerate, setAutoGenerate] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (!isOpen) return null;

    const effectiveStyle = customStyle.trim() || (styleIdx !== null ? STYLE_PRESETS[styleIdx].anchor : '');

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            setScript(text);
            setError('');
        } catch {
            setError('文件读取失败，请使用 UTF-8 编码的文本文件');
        }
    };

    const handleSubmit = async () => {
        if (!script.trim()) {
            setError('请先输入或上传小说/剧本内容');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/story-workflow/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    script: script.trim(),
                    shotDuration,
                    maxShots,
                    style: effectiveStyle,
                    aspectRatio,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || '剧本分析失败');
            onCreate(data as StoryWorkflowResult, { autoGenerate, aspectRatio });
            onClose();
        } catch (err: any) {
            setError(err?.message || '剧本分析失败，请重试');
        } finally {
            setLoading(false);
        }
    };

    const labelCls = 'flex items-center gap-1.5 text-xs font-medium text-neutral-400 mb-1.5';

    return (
        <div className="fixed inset-x-0 bottom-0 z-[9000] flex items-center justify-center" style={{ top: 'var(--titlebar-h, 0px)' }}>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={loading ? undefined : onClose} />

            <div className="relative w-[640px] max-h-[88vh] flex flex-col bg-[#141416] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-500/20 flex items-center justify-center">
                            <Wand2 size={16} className="text-cyan-400" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-white">一键创建工作流</h2>
                            <p className="text-[11px] text-neutral-500">输入小说或剧本，AI 自动生成资产、分镜与视频节点</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={loading}
                        className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {/* 剧本输入 */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className={labelCls + ' mb-0'}>
                                <BookOpen size={13} className="text-neutral-500" />
                                小说 / 剧本内容
                            </label>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={loading}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 border border-white/[0.06] transition-colors"
                            >
                                <Upload size={11} />
                                上传文本文件
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".txt,.md,text/plain"
                                className="hidden"
                                onChange={handleFileUpload}
                            />
                        </div>
                        <textarea
                            value={script}
                            onChange={e => setScript(e.target.value)}
                            disabled={loading}
                            placeholder="粘贴小说章节或剧本原文（支持上传 .txt 文件）。AI 将自动提取人物、场景、道具，并改编为分镜……"
                            className="w-full h-44 px-3 py-2.5 bg-black/40 border border-white/10 rounded-xl text-[13px] text-neutral-200 placeholder-neutral-600 resize-none outline-none focus:border-cyan-500/50 transition-colors leading-relaxed"
                        />
                        <div className="mt-1 text-right text-[10px] text-neutral-600">{script.length} 字</div>
                    </div>

                    {/* 单镜头时长 */}
                    <div>
                        <label className={labelCls}>
                            <Clock size={13} className="text-neutral-500" />
                            单镜头时长
                        </label>
                        <div className="flex gap-1.5">
                            {DURATION_OPTIONS.map(d => (
                                <button
                                    key={d}
                                    onClick={() => setShotDuration(d)}
                                    disabled={loading}
                                    className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${shotDuration === d
                                        ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                                        : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'
                                        }`}
                                >
                                    {d} 秒
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 参数行：画幅比例 + 分镜数 */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelCls}>
                                <Monitor size={13} className="text-neutral-500" />
                                画幅比例（图片与视频统一）
                            </label>
                            <div className="flex gap-1.5">
                                {RATIO_OPTIONS.map(r => (
                                    <button
                                        key={r.value}
                                        onClick={() => setAspectRatio(r.value)}
                                        disabled={loading}
                                        className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${aspectRatio === r.value
                                            ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                                            : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'
                                            }`}
                                    >
                                        {r.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>
                                <Clapperboard size={13} className="text-neutral-500" />
                                分镜数量
                            </label>
                            <div className="flex gap-1.5">
                                {SHOT_COUNT_OPTIONS.map(c => (
                                    <button
                                        key={c}
                                        onClick={() => setMaxShots(c)}
                                        disabled={loading}
                                        className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${maxShots === c
                                            ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                                            : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'
                                            }`}
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* 视频风格 */}
                    <div>
                        <label className={labelCls}>
                            <Palette size={13} className="text-neutral-500" />
                            视频风格（统一全片画风）
                        </label>
                        <div className="grid grid-cols-3 gap-1.5 mb-2">
                            {STYLE_PRESETS.map((p, i) => (
                                <button
                                    key={p.label}
                                    onClick={() => { setStyleIdx(i); setCustomStyle(''); }}
                                    disabled={loading}
                                    className={`py-1.5 rounded-lg text-xs border transition-colors ${styleIdx === i && !customStyle.trim()
                                        ? 'bg-violet-500/15 border-violet-500/50 text-violet-300'
                                        : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'
                                        }`}
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                        <input
                            value={customStyle}
                            onChange={e => setCustomStyle(e.target.value)}
                            disabled={loading}
                            placeholder="或自定义风格描述，如：吉卜力风格，手绘水彩质感，温暖色调……"
                            className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-violet-500/50 transition-colors"
                        />
                    </div>

                    {/* 自动生图开关 */}
                    <button
                        onClick={() => setAutoGenerate(v => !v)}
                        disabled={loading}
                        className="w-full flex items-center justify-between px-3.5 py-3 bg-white/[0.03] border border-white/[0.07] rounded-xl hover:bg-white/[0.05] transition-colors"
                    >
                        <div className="flex items-center gap-2.5 text-left">
                            <Zap size={15} className={autoGenerate ? 'text-amber-400' : 'text-neutral-500'} />
                            <div>
                                <div className="text-xs font-medium text-neutral-200">创建后自动生成图片</div>
                                <div className="text-[10px] text-neutral-500 mt-0.5">先生成资产图，完成后再生成分镜图（会消耗图片额度）；关闭则仅创建节点</div>
                            </div>
                        </div>
                        <div className={`relative w-9 h-5 rounded-full transition-colors ${autoGenerate ? 'bg-amber-500/80' : 'bg-white/10'}`}>
                            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoGenerate ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                        </div>
                    </button>

                    {error && (
                        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-black/20">
                    <div className="text-[10px] text-neutral-600">
                        {loading ? 'AI 正在分析剧本与设计分镜，约需 1～3 分钟，请勿关闭…' : '使用「设置」中配置的文字模型进行分析'}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={onClose}
                            disabled={loading}
                            className="px-4 py-2 rounded-lg text-xs text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 transition-colors disabled:opacity-40"
                        >
                            取消
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={loading || !script.trim()}
                            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-cyan-500/10"
                        >
                            {loading ? (
                                <>
                                    <Loader2 size={13} className="animate-spin" />
                                    分析中…
                                </>
                            ) : (
                                <>
                                    <Wand2 size={13} />
                                    开始创建
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
