/**
 * StoryWorkflowModal - 一键创建工作流（三段式专业流水线）
 *
 * 输入小说/剧本 + 参数 + 选择「提示词模板」，调用三段式 AI 分析
 * （小说→节拍剧本→人物/场景/道具资产→分镜），自动生成画布节点与连线。
 * 分镜数量支持 Auto（AI 按节奏自动决定）；提示词模板可切换/编辑/导入/另存为自定义。
 */

import React, { useEffect, useRef, useState } from 'react';
import { X, Wand2, Upload, Loader2, BookOpen, Clock, Clapperboard, Zap, Monitor, Sparkles, FileText, Save, Trash2, Pencil } from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

export interface StoryAsset { name: string; desc: string; prompt: string; }

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
    shotSize?: string;
}

export interface StoryWorkflowResult {
    title: string;
    summary: string;
    styleAnchor: string;
    characters: StoryAsset[];
    scenes: StoryAsset[];
    props: StoryAsset[];
    shots: StoryShot[];
    screenplay?: string;
}

interface PromptTemplate {
    id: string;
    name: string;
    desc?: string;
    builtin: boolean;
    styleAnchor: string;
    screenplayPrompt: string;
    assetPrompt: string;
    storyboardPrompt: string;
}

interface StoryWorkflowModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (result: StoryWorkflowResult, opts: { autoGenerate: boolean; aspectRatio: string }) => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DURATION_OPTIONS = [4, 6, 8, 10, 12, 15];
const SHOT_COUNT_MIN = 3;
const SHOT_COUNT_MAX = 30;
const RATIO_OPTIONS: { value: string; label: string }[] = [
    { value: '16:9', label: '16:9 横屏' },
    { value: '9:16', label: '9:16 竖屏' },
];

type EditorTab = 'screenplay' | 'asset' | 'storyboard';
const EDITOR_TABS: { id: EditorTab; label: string }[] = [
    { id: 'screenplay', label: '① 小说→剧本' },
    { id: 'asset', label: '② 提取资产' },
    { id: 'storyboard', label: '③ 剧本→分镜' },
];

// ============================================================================
// COMPONENT
// ============================================================================

export const StoryWorkflowModal: React.FC<StoryWorkflowModalProps> = ({ isOpen, onClose, onCreate }) => {
    const [script, setScript] = useState('');
    const [shotDuration, setShotDuration] = useState(6);
    const [maxShots, setMaxShots] = useState(12);
    const [autoShots, setAutoShots] = useState(true); // 默认 AI 自动判定镜头数
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [autoGenerate, setAutoGenerate] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // 提示词模板
    const [templates, setTemplates] = useState<PromptTemplate[]>([]);
    const [templateId, setTemplateId] = useState('');
    // 当前可编辑副本（基于所选模板，可被用户修改）
    const [draft, setDraft] = useState<{ styleAnchor: string; screenplayPrompt: string; assetPrompt: string; storyboardPrompt: string }>({
        styleAnchor: '', screenplayPrompt: '', assetPrompt: '', storyboardPrompt: '',
    });
    const [showEditor, setShowEditor] = useState(false);
    const [editorTab, setEditorTab] = useState<EditorTab>('storyboard');
    const [savingTpl, setSavingTpl] = useState(false);

    // 分析进度（三段）
    const [stage, setStage] = useState('');
    const [chars, setChars] = useState(0);
    const [stageNo, setStageNo] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const tplImportRef = useRef<HTMLInputElement>(null);

    const curTpl = templates.find(t => t.id === templateId);

    // 载入模板
    const loadTemplates = async (selectId?: string) => {
        try {
            const r = await fetch('/api/prompt-templates');
            const list: PromptTemplate[] = await r.json();
            if (Array.isArray(list) && list.length > 0) {
                setTemplates(list);
                const pick = list.find(t => t.id === selectId) || list.find(t => t.id === templateId) || list[0];
                applyTemplate(pick);
            }
        } catch { /* 忽略，可手动重试 */ }
    };

    const applyTemplate = (t: PromptTemplate) => {
        setTemplateId(t.id);
        setDraft({
            styleAnchor: t.styleAnchor || '',
            screenplayPrompt: t.screenplayPrompt || '',
            assetPrompt: t.assetPrompt || '',
            storyboardPrompt: t.storyboardPrompt || '',
        });
    };

    useEffect(() => {
        if (isOpen && templates.length === 0) loadTemplates();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen) return null;

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try { setScript(await file.text()); setError(''); }
        catch { setError('文件读取失败，请使用 UTF-8 编码的文本文件'); }
    };

    const handleTplImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const txt = await file.text();
            // 导入到当前编辑中的那一段提示词
            setDraft(d => ({ ...d, [editorTab === 'screenplay' ? 'screenplayPrompt' : editorTab === 'asset' ? 'assetPrompt' : 'storyboardPrompt']: txt }));
            setShowEditor(true);
        } catch { setError('提示词文件读取失败'); }
    };

    const handleSaveTemplate = async () => {
        const name = window.prompt('保存为自定义模板，请输入模板名称：', (curTpl?.name ? curTpl.name + ' 副本' : '我的模板'));
        if (!name) return;
        setSavingTpl(true);
        try {
            const r = await fetch('/api/prompt-templates', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    desc: '自定义模板',
                    styleAnchor: draft.styleAnchor,
                    screenplayPrompt: draft.screenplayPrompt,
                    assetPrompt: draft.assetPrompt,
                    storyboardPrompt: draft.storyboardPrompt,
                }),
            });
            const saved = await r.json();
            if (!r.ok) throw new Error(saved.error || '保存失败');
            await loadTemplates(saved.id);
        } catch (err: any) { setError(err.message || '保存模板失败'); }
        finally { setSavingTpl(false); }
    };

    const handleDeleteTemplate = async () => {
        if (!curTpl || curTpl.builtin) return;
        if (!window.confirm(`删除自定义模板「${curTpl.name}」？`)) return;
        try {
            await fetch(`/api/prompt-templates/${curTpl.id}`, { method: 'DELETE' });
            await loadTemplates('builtin-general');
        } catch { setError('删除失败'); }
    };

    const handleSubmit = async () => {
        if (!script.trim()) { setError('请先输入或上传小说/剧本内容'); return; }
        setLoading(true);
        setError('');
        setStage('正在提交剧本…'); setChars(0); setStageNo(0); setElapsed(0);
        timerRef.current = setInterval(() => setElapsed(v => v + 1), 1000);
        try {
            const res = await fetch('/api/story-workflow/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    script: script.trim(),
                    shotDuration,
                    maxShots: autoShots ? 'auto' : maxShots,
                    aspectRatio,
                    styleAnchor: draft.styleAnchor,
                    prompts: {
                        screenplay: draft.screenplayPrompt,
                        asset: draft.assetPrompt,
                        storyboard: draft.storyboardPrompt,
                    },
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error((data as any)?.error || '剧本分析失败');
            }
            if (!res.body) throw new Error('浏览器不支持流式响应');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            let result: StoryWorkflowResult | null = null;
            let serverError = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const parts = buf.split('\n\n');
                buf = parts.pop() || '';
                for (const part of parts) {
                    const line = part.trim();
                    if (!line.startsWith('data:')) continue;
                    let evt: any;
                    try { evt = JSON.parse(line.slice(5)); } catch { continue; }
                    if (evt.type === 'status') setStage(evt.message);
                    else if (evt.type === 'progress') { setChars(evt.chars); if (evt.stage) setStageNo(evt.stage); }
                    else if (evt.type === 'done') result = evt.data;
                    else if (evt.type === 'error') serverError = evt.error;
                }
            }
            if (serverError) throw new Error(serverError);
            if (!result) throw new Error('连接中断，未收到分析结果，请重试');
            onCreate(result, { autoGenerate, aspectRatio });
            onClose();
        } catch (err: any) {
            setError(err?.message || '剧本分析失败，请重试');
        } finally {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            setLoading(false);
        }
    };

    const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const labelCls = 'flex items-center gap-1.5 text-xs font-medium text-neutral-400 mb-1.5';
    const draftKey: Record<EditorTab, keyof typeof draft> = { screenplay: 'screenplayPrompt', asset: 'assetPrompt', storyboard: 'storyboardPrompt' };

    return (
        <div className="fixed inset-x-0 bottom-0 z-[9000] flex items-center justify-center" style={{ top: 'var(--titlebar-h, 0px)' }}>
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={loading ? undefined : onClose} />

            <div className="relative w-[680px] max-h-[90vh] flex flex-col bg-[#141416] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-500/20 flex items-center justify-center">
                            <Wand2 size={16} className="text-cyan-400" />
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold text-white">一键创建工作流</h2>
                            <p className="text-[11px] text-neutral-500">三段式 AI 流水线：小说 → 节拍剧本 → 人物/场景/道具 → 分镜</p>
                        </div>
                    </div>
                    <button onClick={onClose} disabled={loading} className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40">
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {/* 剧本输入 */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className={labelCls + ' mb-0'}><BookOpen size={13} className="text-neutral-500" /> 小说 / 剧本内容</label>
                            <button onClick={() => fileInputRef.current?.click()} disabled={loading}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 border border-white/[0.06] transition-colors">
                                <Upload size={11} /> 上传文本文件
                            </button>
                            <input ref={fileInputRef} type="file" accept=".txt,.md,text/plain" className="hidden" onChange={handleFileUpload} />
                        </div>
                        <textarea
                            value={script}
                            onChange={e => setScript(e.target.value)}
                            disabled={loading}
                            placeholder="粘贴小说章节或剧本原文（支持上传 .txt）。AI 会先改编为节拍剧本，再提取人物/场景/道具，最后按节奏生成分镜……"
                            className="w-full h-40 px-3 py-2.5 bg-black/40 border border-white/10 rounded-xl text-[13px] text-neutral-200 placeholder-neutral-600 resize-none outline-none focus:border-cyan-500/50 transition-colors leading-relaxed"
                        />
                        <div className="mt-1 text-right text-[10px] text-neutral-600">{script.length} 字</div>
                    </div>

                    {/* 单镜头时长 */}
                    <div>
                        <label className={labelCls}><Clock size={13} className="text-neutral-500" /> 单镜头基准时长</label>
                        <div className="flex gap-1.5">
                            {DURATION_OPTIONS.map(d => (
                                <button key={d} onClick={() => setShotDuration(d)} disabled={loading}
                                    className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${shotDuration === d ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300' : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'}`}>
                                    {d} 秒
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 画幅 + 分镜数（支持 Auto） */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelCls}><Monitor size={13} className="text-neutral-500" /> 画幅比例</label>
                            <div className="flex gap-1.5">
                                {RATIO_OPTIONS.map(r => (
                                    <button key={r.value} onClick={() => setAspectRatio(r.value)} disabled={loading}
                                        className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${aspectRatio === r.value ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300' : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white hover:bg-white/[0.07]'}`}>
                                        {r.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>
                                <Clapperboard size={13} className="text-neutral-500" /> 分镜数量
                                <span className="ml-auto text-cyan-300 font-semibold text-xs tabular-nums">{autoShots ? 'AI 自动' : `${maxShots} 个`}</span>
                            </label>
                            <div className="flex items-center gap-2">
                                <button onClick={() => setAutoShots(v => !v)} disabled={loading}
                                    className={`px-2 py-1.5 rounded-lg text-[11px] border transition-colors flex items-center gap-1 ${autoShots ? 'bg-violet-500/15 border-violet-500/50 text-violet-300' : 'bg-white/[0.03] border-white/[0.07] text-neutral-400 hover:text-white'}`}
                                    title="由 AI 按剧情节奏自动决定镜头数">
                                    <Sparkles size={11} /> Auto
                                </button>
                                <input type="range" min={SHOT_COUNT_MIN} max={SHOT_COUNT_MAX} step={1} value={maxShots}
                                    onChange={e => { setMaxShots(Number(e.target.value)); setAutoShots(false); }}
                                    disabled={loading}
                                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-cyan-400 disabled:opacity-40"
                                    title="拖动设置固定分镜数量" />
                            </div>
                            <div className="text-[10px] text-neutral-600 px-1 mt-1">
                                {autoShots ? 'AI 按节奏（快/中/慢）自动决定镜头数' : `约 ${Math.round(maxShots * shotDuration)} 秒成片`}
                            </div>
                        </div>
                    </div>

                    {/* 提示词模板 */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className={labelCls + ' mb-0'}><FileText size={13} className="text-neutral-500" /> 提示词模板（决定画风与专业度）</label>
                            <button onClick={() => setShowEditor(v => !v)} disabled={loading}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 border border-white/[0.06] transition-colors">
                                <Pencil size={11} /> {showEditor ? '收起编辑' : '查看 / 编辑'}
                            </button>
                        </div>
                        <div className="flex gap-2">
                            <select value={templateId} onChange={e => { const t = templates.find(x => x.id === e.target.value); if (t) applyTemplate(t); }}
                                disabled={loading}
                                className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 outline-none focus:border-cyan-500/50">
                                {templates.map(t => <option key={t.id} value={t.id}>{t.builtin ? '[内置] ' : '[自定义] '}{t.name}</option>)}
                            </select>
                            {curTpl && !curTpl.builtin && (
                                <button onClick={handleDeleteTemplate} disabled={loading} title="删除该自定义模板"
                                    className="px-2.5 rounded-lg text-neutral-500 hover:text-red-400 bg-white/[0.04] hover:bg-white/10 border border-white/[0.06]">
                                    <Trash2 size={13} />
                                </button>
                            )}
                        </div>
                        {curTpl?.desc && <div className="mt-1 text-[10px] text-neutral-600">{curTpl.desc}</div>}

                        {/* 风格锚定词（始终可改） */}
                        <input value={draft.styleAnchor} onChange={e => setDraft(d => ({ ...d, styleAnchor: e.target.value }))} disabled={loading}
                            placeholder="风格锚定词（统一全片画风，可自定义覆盖）"
                            className="w-full mt-2 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-violet-500/50" />

                        {/* 三段提示词编辑器 */}
                        {showEditor && (
                            <div className="mt-2 border border-white/10 rounded-xl overflow-hidden bg-black/30">
                                <div className="flex items-center border-b border-white/[0.06]">
                                    {EDITOR_TABS.map(t => (
                                        <button key={t.id} onClick={() => setEditorTab(t.id)} disabled={loading}
                                            className={`flex-1 py-2 text-[11px] transition-colors ${editorTab === t.id ? 'text-cyan-300 bg-white/[0.04] border-b-2 border-cyan-400' : 'text-neutral-500 hover:text-neutral-300'}`}>
                                            {t.label}
                                        </button>
                                    ))}
                                </div>
                                <textarea
                                    value={draft[draftKey[editorTab]]}
                                    onChange={e => setDraft(d => ({ ...d, [draftKey[editorTab]]: e.target.value }))}
                                    disabled={loading}
                                    spellCheck={false}
                                    className="w-full h-48 px-3 py-2.5 bg-transparent text-[11px] text-neutral-300 placeholder-neutral-600 resize-none outline-none leading-relaxed font-mono"
                                    placeholder="该阶段的系统提示词…"
                                />
                                <div className="flex items-center justify-between px-2.5 py-2 border-t border-white/[0.06] bg-black/20">
                                    <div className="text-[10px] text-neutral-600">{curTpl?.builtin ? '编辑内置模板后请「另存为自定义」' : '编辑后可「另存为自定义」'}</div>
                                    <div className="flex gap-1.5">
                                        <button onClick={() => tplImportRef.current?.click()} disabled={loading}
                                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 border border-white/[0.06]">
                                            <Upload size={11} /> 导入当前段
                                        </button>
                                        <input ref={tplImportRef} type="file" accept=".txt,.md,text/plain" className="hidden" onChange={handleTplImport} />
                                        <button onClick={handleSaveTemplate} disabled={loading || savingTpl}
                                            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-white bg-cyan-600/80 hover:bg-cyan-500 disabled:opacity-50">
                                            {savingTpl ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} 另存为自定义
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 自动生图开关 */}
                    <button onClick={() => setAutoGenerate(v => !v)} disabled={loading}
                        className="w-full flex items-center justify-between px-3.5 py-3 bg-white/[0.03] border border-white/[0.07] rounded-xl hover:bg-white/[0.05] transition-colors">
                        <div className="flex items-center gap-2.5 text-left">
                            <Zap size={15} className={autoGenerate ? 'text-amber-400' : 'text-neutral-500'} />
                            <div>
                                <div className="text-xs font-medium text-neutral-200">创建后自动生成图片</div>
                                <div className="text-[10px] text-neutral-500 mt-0.5">先生成资产图，再生成分镜图（消耗图片额度）；关闭则仅创建节点</div>
                            </div>
                        </div>
                        <div className={`relative w-9 h-5 rounded-full transition-colors ${autoGenerate ? 'bg-amber-500/80' : 'bg-white/10'}`}>
                            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoGenerate ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                        </div>
                    </button>

                    {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">{error}</div>}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-black/20">
                    <div className="text-[10px] text-neutral-600">
                        {loading ? '三段式 AI 分析中，约需 2～5 分钟，请勿关闭…' : '三段式流水线，使用「设置」中配置的文字模型'}
                    </div>
                    <div className="flex gap-2">
                        <button onClick={onClose} disabled={loading}
                            className="px-4 py-2 rounded-lg text-xs text-neutral-400 hover:text-white bg-white/[0.04] hover:bg-white/10 transition-colors disabled:opacity-40">取消</button>
                        <button onClick={handleSubmit} disabled={loading || !script.trim()}
                            className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-medium text-white bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-cyan-500/10">
                            {loading ? <><Loader2 size={13} className="animate-spin" /> 分析中…</> : <><Wand2 size={13} /> 开始创建</>}
                        </button>
                    </div>
                </div>

                {/* 分析进度浮层（三段） */}
                {loading && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#141416]/90 backdrop-blur-md">
                        <div className="relative w-16 h-16 mb-5">
                            <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20" />
                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-cyan-400 animate-spin" />
                            <div className="absolute inset-0 flex items-center justify-center"><Wand2 size={22} className="text-cyan-400" /></div>
                        </div>
                        {/* 三段步骤指示 */}
                        <div className="flex items-center gap-2 mb-3">
                            {['剧本', '资产', '分镜'].map((s, i) => (
                                <div key={s} className={`flex items-center gap-1 text-[11px] ${stageNo > i + 1 ? 'text-emerald-400' : stageNo === i + 1 ? 'text-cyan-300' : 'text-neutral-600'}`}>
                                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] border ${stageNo >= i + 1 ? 'border-current' : 'border-neutral-700'}`}>{i + 1}</span>
                                    {s}
                                    {i < 2 && <span className="mx-0.5 text-neutral-700">→</span>}
                                </div>
                            ))}
                        </div>
                        <div className="text-sm font-medium text-white mb-1.5">{stage || 'AI 分析中…'}</div>
                        <div className="text-[11px] text-neutral-500 mb-4">{chars > 0 ? `本段已生成 ${chars.toLocaleString()} 字符` : '正在处理…'}</div>
                        <div className="flex items-center gap-3 text-[11px] text-neutral-600">
                            <span>已用时 {fmtTime(elapsed)}</span><span className="text-neutral-700">·</span><span>通常需要 2～5 分钟</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
