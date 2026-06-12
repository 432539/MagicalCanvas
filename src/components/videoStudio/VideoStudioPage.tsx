/**
 * VideoStudioPage.tsx
 *
 * 视频剪辑工作室（类剪映）：
 * - 左侧素材库：拉取项目里所有生成的视频
 * - 中间预览播放器（含字幕叠加、配音同步）
 * - 底部时间轴：视频轨（裁剪/排序/转场）、配音轨、字幕轨
 * - 智能配音：AI 脚本 → 逐句 TTS → 自动生成配音 + 字幕时间轴
 * - 导出：服务端 ffmpeg 合成（转场 xfade + 字幕烧录 + 配音混音）
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    X, Play, Pause, Plus, Trash2, ChevronUp, ChevronDown, Scissors,
    Loader2, Download, Mic, Captions, Sparkles, Film, ArrowLeftRight, Check,
    Undo2, Redo2, Maximize2, Minimize2, Save
} from 'lucide-react';
import { showAppConfirm } from '../ui/AppDialog';

// ============================================================================
// 类型
// ============================================================================

interface LibraryAsset {
    id: string;
    url: string;
    prompt?: string;
    title?: string;     // 来源节点标题（如「镜头 01 视频」），用于区分镜头
    createdAt?: string;
    assetType: 'video' | 'image';
}

interface ClipEq {
    brightness: number; // -0.5 ~ 0.5（0 = 原始）
    contrast: number;   // 0.5 ~ 2（1 = 原始）
    saturation: number; // 0 ~ 3（1 = 原始）
}

interface Clip {
    id: string;
    url: string;
    name: string;
    sourceDuration: number; // 素材原始时长
    inPoint: number;
    outPoint: number;
    speed: number;          // 0.25 ~ 4（1 = 原速）
    muted: boolean;         // 本片段原声静音
    volume: number;         // 0 ~ 2
    reverse: boolean;       // 倒放（导出生效）
    rotate: 0 | 90 | 180 | 270;
    flipH: boolean;
    flipV: boolean;
    eq: ClipEq;
    scale: number;  // 画面缩放 0.2 ~ 3（1 = 原始）
    posX: number;   // 位置偏移 -1 ~ 1（画面宽度比例）
    posY: number;   // 位置偏移 -1 ~ 1（画面高度比例）
    effect: string | null; // 特效 id（见 FX_PRESETS）
    isImage?: boolean;     // 图片素材（显示时长 = 出点 - 入点）
}

/** 片段在时间轴上的有效时长（变速后） */
const clipDur = (c: Clip) => (c.outPoint - c.inPoint) / c.speed;

const DEFAULT_EQ: ClipEq = { brightness: 0, contrast: 1, saturation: 1 };

interface Transition {
    type: string;     // none | fade | dissolve | wipeleft | ...
    duration: number; // 秒
}

interface SubtitleStyle {
    fontScale: number;        // 字号：相对输出画面高度的比例（0.02~0.15）
    color: string;            // 字体颜色
    outlineColor: string;     // 描边颜色
    background: boolean;      // 是否显示背景气泡
    backgroundColor: string;  // 背景气泡颜色
    x: number;                // 位置 x：0~1 画面比例（0.5 = 水平居中）
    y: number;                // 位置 y：0~1 画面比例（0.92 = 底部）
    maxW?: number;            // 最大宽度：0.3~1 画面宽度比例，超出自动换行（默认 0.9）
    bgOpacity?: number;       // 背景气泡不透明度 0~1（默认 0.85）
    anim?: 'none' | 'fade' | 'slideup' | 'pop'; // 入场动画
}

interface SubtitleItem {
    id: string;
    text: string;
    start: number;
    end: number;
    style: SubtitleStyle;
}

interface AudioItem {
    id: string;
    url: string;
    text: string;
    start: number;
    duration: number;  // 素材原始总时长
    inPoint: number;   // 裁剪入点（素材秒）
    outPoint: number;  // 裁剪出点（素材秒）
    volume: number;    // 0 ~ 2
    muted: boolean;
    speed: number;     // 0.25 ~ 4
    fadeIn: number;    // 淡入秒数（导出生效）
    fadeOut: number;   // 淡出秒数（导出生效）
    isMusic?: boolean; // 是否为导入的音乐
    track?: number;    // 所属音轨（0 起；可分人声/背景声/BGM 等多轨）
}

/** 音频条目所属音轨（兼容旧数据：缺省为 0） */
const aTrack = (a: AudioItem) => Math.max(0, a.track ?? 0);

const MAX_AUDIO_LANES = 4;

/** 画中画蒙版形状 */
type OverlayMask = 'none' | 'circle' | 'roundrect';

/** 画中画片段：在主视频上方叠加的小窗视频/图片（自由摆放时间与位置） */
interface OverlayClip extends Clip {
    start: number;  // 时间轴起点（秒，自由放置）
    track: number;  // 画中画轨道（0 起）
    mask?: OverlayMask; // 蒙版形状（缺省无）
}

const OVERLAY_MASKS: { id: OverlayMask; name: string }[] = [
    { id: 'none', name: '无' },
    { id: 'circle', name: '圆形' },
    { id: 'roundrect', name: '圆角' },
];

/** 蒙版对应的 CSS clip-path / 圆角（预览用） */
const maskClipStyle = (mask?: OverlayMask): React.CSSProperties => {
    if (mask === 'circle') return { clipPath: 'ellipse(50% 50% at 50% 50%)' };
    if (mask === 'roundrect') return { borderRadius: '10%', overflow: 'hidden' };
    return {};
};

const oTrack = (o: OverlayClip) => Math.max(0, o.track ?? 0);
const MAX_OVERLAY_LANES = 2;

/** 音频条目在时间轴上的有效时长（裁剪 + 变速后） */
const audioDur = (a: AudioItem) => (a.outPoint - a.inPoint) / a.speed;

interface Sticker {
    id: string;
    emoji: string;
    x: number;     // 0~1 画面比例
    y: number;     // 0~1
    size: number;  // 相对画面高度 0.05~0.8
    start: number;
    end: number;
}

interface VoiceOption { id: string; name: string; }

/** 已保存剪辑项目的元信息（下拉历史列表用） */
interface EditProjectMeta {
    id: string;
    name: string;
    updatedAt?: string;
    clipCount?: number;
}

interface VideoStudioPageProps {
    isOpen: boolean;
    onClose: () => void;
}

// ============================================================================
// 常量
// ============================================================================

// 36 种转场（全部为 ffmpeg xfade 内置，导出精确渲染）
const TRANSITIONS: { id: string; name: string }[] = [
    { id: 'none', name: '无（硬切）' },
    { id: 'fade', name: '淡入淡出' },
    { id: 'fadeblack', name: '黑场过渡' },
    { id: 'fadewhite', name: '白场过渡' },
    { id: 'fadegrays', name: '灰度过渡' },
    { id: 'dissolve', name: '叠化' },
    { id: 'distance', name: '距离溶解' },
    { id: 'wipeleft', name: '左擦除' },
    { id: 'wiperight', name: '右擦除' },
    { id: 'wipeup', name: '上擦除' },
    { id: 'wipedown', name: '下擦除' },
    { id: 'slideleft', name: '左滑动' },
    { id: 'slideright', name: '右滑动' },
    { id: 'slideup', name: '上滑动' },
    { id: 'slidedown', name: '下滑动' },
    { id: 'smoothleft', name: '平滑左移' },
    { id: 'smoothright', name: '平滑右移' },
    { id: 'smoothup', name: '平滑上移' },
    { id: 'smoothdown', name: '平滑下移' },
    { id: 'circleopen', name: '圆形展开' },
    { id: 'circleclose', name: '圆形收拢' },
    { id: 'circlecrop', name: '圆形裁切' },
    { id: 'rectcrop', name: '矩形裁切' },
    { id: 'radial', name: '雷达扫描' },
    { id: 'pixelize', name: '像素化' },
    { id: 'hblur', name: '动感模糊' },
    { id: 'zoomin', name: '放大推进' },
    { id: 'vertopen', name: '左右开门' },
    { id: 'horzopen', name: '上下开门' },
    { id: 'diagtl', name: '对角擦除' },
    { id: 'hlslice', name: '竖百叶窗' },
    { id: 'vuslice', name: '横百叶窗' },
    { id: 'hlwind', name: '风吹效果' },
    { id: 'coverleft', name: '左侧覆盖' },
    { id: 'revealright', name: '右侧揭示' },
    { id: 'squeezeh', name: '上下挤压' },
];

const RESOLUTIONS = [
    { id: '1280x720', name: '720p 横屏', w: 1280, h: 720 },
    { id: '1920x1080', name: '1080p 横屏', w: 1920, h: 1080 },
    { id: '720x1280', name: '720p 竖屏', w: 720, h: 1280 },
    { id: '1080x1920', name: '1080p 竖屏', w: 1080, h: 1920 },
];

// 18 种特效预设（css 用于预览近似，导出由 ffmpeg 精确处理）
const FX_PRESETS: { id: string; name: string; css: string; dark?: boolean }[] = [
    { id: 'none', name: '无', css: '' },
    { id: 'bw', name: '黑白', css: 'grayscale(1)' },
    { id: 'vivid', name: '鲜艳', css: 'saturate(1.45) contrast(1.08)' },
    { id: 'sepia', name: '复古', css: 'sepia(0.9)' },
    { id: 'cold', name: '冷色调', css: 'sepia(0.15) hue-rotate(180deg) saturate(1.2)' },
    { id: 'warm', name: '暖色调', css: 'sepia(0.3) saturate(1.25)' },
    { id: 'vignette', name: '暗角', css: '', dark: true },
    { id: 'blur', name: '模糊', css: 'blur(5px)' },
    { id: 'oldfilm', name: '老电影', css: 'sepia(0.55) contrast(1.1) brightness(0.95)', dark: true },
    { id: 'sharpen', name: '锐化', css: 'contrast(1.06)' },
    { id: 'grain', name: '噪点颗粒', css: 'contrast(1.03)' },
    { id: 'pixel', name: '马赛克', css: 'blur(2px)' },
    { id: 'negative', name: '负片', css: 'invert(1)' },
    { id: 'vintage', name: '怀旧胶片', css: 'sepia(0.45) contrast(0.95) brightness(1.02)' },
    { id: 'crossprocess', name: '交叉冲印', css: 'saturate(1.35) contrast(1.15) hue-rotate(-8deg)' },
    { id: 'strongcontrast', name: '高对比', css: 'contrast(1.4)' },
    { id: 'tealorange', name: '青橙大片', css: 'sepia(0.25) saturate(1.4) hue-rotate(-12deg)' },
    { id: 'dreampurple', name: '梦幻紫', css: 'hue-rotate(35deg) saturate(1.2)' },
    { id: 'sketch', name: '边缘素描', css: 'grayscale(0.6) contrast(1.4)' },
];

// 贴纸预设资源（分组 emoji，预览与导出均为系统彩色 emoji 渲染）
const STICKER_GROUPS: { name: string; emojis: string[] }[] = [
    {
        name: '热门',
        emojis: ['🔥', '❤️', '😂', '👍', '✨', '🎉', '💯', '😍', '🤣', '👏', '😭', '🌟', '💖', '🎵', '⚡', '🥳'],
    },
    {
        name: '表情',
        emojis: ['😀', '😅', '🥰', '😘', '😜', '🤪', '😏', '😎', '🤔', '🙄', '😱', '🥺', '😤', '🤯', '🥶', '😴', '🤤', '😇', '🤡', '💀'],
    },
    {
        name: '手势',
        emojis: ['💪', '🙏', '👌', '✌️', '🤞', '🤙', '👊', '✊', '🫶', '👆', '👇', '👈', '👉', '🤝', '👋', '🖐️'],
    },
    {
        name: '动物',
        emojis: ['🐱', '🐶', '🐰', '🦊', '🐻', '🐼', '🐯', '🦁', '🐷', '🐸', '🐵', '🦄', '🐔', '🦋', '🐳', '🦖'],
    },
    {
        name: '美食',
        emojis: ['🍕', '🍔', '🍟', '🌭', '🍿', '🧋', '🍩', '🍰', '🍦', '🍓', '🍉', '🍑', '🥤', '🍜', '🍣', '🍺'],
    },
    {
        name: '符号',
        emojis: ['❗', '❓', '💥', '🚀', '🎁', '🏆', '👑', '💰', '💎', '🎯', '📢', '🔔', '💣', '⭐', '🌈', '☀️', '🌙', '☁️', '💨', '🎈'],
    },
];

/** 把 emoji 渲染为 PNG dataURL（导出贴纸用，保证彩色） */
function renderEmojiToPng(emoji: string, px = 256): string {
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${Math.round(px * 0.8)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, px / 2, px / 2 + px * 0.04);
    return canvas.toDataURL('image/png');
}

const DEFAULT_SUB_STYLE: SubtitleStyle = {
    fontScale: 0.052,
    color: '#ffffff',
    outlineColor: '#000000',
    background: false,
    backgroundColor: '#000000',
    x: 0.5,
    y: 0.92,
    maxW: 0.9,
    bgOpacity: 0.85,
    anim: 'none',
};

const SUB_ANIMS: { id: NonNullable<SubtitleStyle['anim']>; name: string }[] = [
    { id: 'none', name: '无' },
    { id: 'fade', name: '淡入' },
    { id: 'slideup', name: '上滑' },
    { id: 'pop', name: '弹入' },
];

// 8 种经典预设样式（参考剪映热门花字）
const SUB_PRESETS: { name: string; patch: Partial<SubtitleStyle>; chipStyle: React.CSSProperties }[] = [
    {
        name: '经典白',
        patch: { color: '#ffffff', outlineColor: '#000000', background: false },
        chipStyle: { color: '#ffffff', textShadow: '0 0 2px #000, 1.5px 1.5px 1px #000' },
    },
    {
        name: '醒目黄',
        patch: { color: '#ffe14d', outlineColor: '#1a1a1a', background: false },
        chipStyle: { color: '#ffe14d', textShadow: '0 0 2px #1a1a1a, 1.5px 1.5px 1px #1a1a1a' },
    },
    {
        name: '综艺橙',
        patch: { color: '#ff8a00', outlineColor: '#ffffff', background: false },
        chipStyle: { color: '#ff8a00', textShadow: '0 0 2px #fff, 1.5px 1.5px 1px #fff' },
    },
    {
        name: '少女粉',
        patch: { color: '#ff7eb6', outlineColor: '#ffffff', background: false },
        chipStyle: { color: '#ff7eb6', textShadow: '0 0 2px #fff, 1.5px 1.5px 1px #fff' },
    },
    {
        name: '科技蓝',
        patch: { color: '#4dd2ff', outlineColor: '#06283d', background: false },
        chipStyle: { color: '#4dd2ff', textShadow: '0 0 3px #06283d, 1.5px 1.5px 1px #06283d' },
    },
    {
        // 描边色与底色一致，描边隐形、文字干净清晰
        name: '黑底白',
        patch: { color: '#ffffff', outlineColor: '#000000', background: true, backgroundColor: '#000000' },
        chipStyle: { color: '#ffffff', background: '#000000', border: '1px solid #555' },
    },
    {
        name: '黄底黑',
        patch: { color: '#1a1a1a', outlineColor: '#ffd700', background: true, backgroundColor: '#ffd700' },
        chipStyle: { color: '#1a1a1a', background: '#ffd700' },
    },
    {
        name: '红底白',
        patch: { color: '#ffffff', outlineColor: '#d32f2f', background: true, backgroundColor: '#d32f2f' },
        chipStyle: { color: '#ffffff', background: '#d32f2f' },
    },
];

/**
 * 预览转场：出场片段最后一帧被绘制到幽灵画布上，按进度 p（0→1）做退场动画。
 * 这是导出 xfade 的近似预览（导出时由 ffmpeg 精确合成）。
 */
function ghostTransStyle(type: string, p: number): { opacity?: number; clipPath?: string; transform?: string; filter?: string } {
    const o = Math.max(0, 1 - p);
    const pct = (Math.min(1, Math.max(0, p)) * 100).toFixed(2);
    if (type.startsWith('wipe') || type.startsWith('smooth') || type.startsWith('rect') || type.startsWith('cover') || type.startsWith('reveal')) {
        if (type.endsWith('tl')) return { clipPath: `inset(0 ${pct}% ${pct}% 0)` };
        if (type.endsWith('tr')) return { clipPath: `inset(0 0 ${pct}% ${pct}%)` };
        if (type.endsWith('bl')) return { clipPath: `inset(${pct}% ${pct}% 0 0)` };
        if (type.endsWith('br')) return { clipPath: `inset(${pct}% 0 0 ${pct}%)` };
        if (type.endsWith('left')) return { clipPath: `inset(0 ${pct}% 0 0)` };
        if (type.endsWith('right')) return { clipPath: `inset(0 0 0 ${pct}%)` };
        if (type.endsWith('up')) return { clipPath: `inset(0 0 ${pct}% 0)` };
        if (type.endsWith('down')) return { clipPath: `inset(${pct}% 0 0 0)` };
        return { opacity: o };
    }
    if (type.startsWith('slide')) {
        if (type.endsWith('left')) return { transform: `translateX(-${pct}%)` };
        if (type.endsWith('right')) return { transform: `translateX(${pct}%)` };
        if (type.endsWith('up')) return { transform: `translateY(-${pct}%)` };
        if (type.endsWith('down')) return { transform: `translateY(${pct}%)` };
        return { opacity: o };
    }
    if (type.startsWith('circle') || type === 'radial') return { clipPath: `circle(${(o * 75).toFixed(2)}% at 50% 50%)` };
    if (type === 'zoomin') return { transform: `scale(${(1 + p * 0.6).toFixed(3)})`, opacity: o };
    if (type === 'fadeblack') return { opacity: o, filter: `brightness(${o.toFixed(2)})` };
    if (type === 'fadewhite') return { opacity: o, filter: `brightness(${(1 + p * 2.5).toFixed(2)})` };
    if (type === 'fadegrays') return { opacity: o, filter: `grayscale(${p.toFixed(2)})` };
    if (type === 'hblur') return { opacity: o, filter: `blur(${(p * 14).toFixed(1)}px)` };
    if (type === 'pixelize' || type === 'dissolve' || type === 'distance') return { opacity: o, filter: `blur(${(p * 7).toFixed(1)}px)` };
    if (type.startsWith('squeeze') || type.startsWith('zoom')) return { transform: `scale(${o.toFixed(3)})`, opacity: o };
    if (type.startsWith('hl') || type.startsWith('hr') || type.startsWith('vu') || type.startsWith('vd') || type.startsWith('diag')) return { opacity: o };
    return { opacity: o }; // fade 及其它类型统一用淡出近似
}

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, '0');
    return `${m}:${sec}`;
};

// ============================================================================
// 主组件
// ============================================================================

export const VideoStudioPage: React.FC<VideoStudioPageProps> = ({ isOpen, onClose }) => {
    // ---- 素材库（视频 + 图片）----
    const [library, setLibrary] = useState<LibraryAsset[]>([]);
    const [libLoading, setLibLoading] = useState(false);
    const [libSelectMode, setLibSelectMode] = useState(false);           // 素材库多选模式
    const [libSelected, setLibSelected] = useState<Set<string>>(new Set()); // 已勾选素材（assetType_id）
    const [libDeleting, setLibDeleting] = useState(false);               // 批量删除中
    const [libFilter, setLibFilter] = useState<'all' | 'video' | 'image'>('all'); // 素材类型筛选
    /** 从标题中提取镜头/分镜编号（如「镜头 03 视频」「分镜 07」→ 3 / 7），无编号返回 Infinity */
    const shotNo = (v: LibraryAsset): number => {
        const m = (v.title || '').match(/(?:镜头|分镜)\s*(\d+)/);
        return m ? parseInt(m[1], 10) : Infinity;
    };
    const filteredLibrary = useMemo(() => {
        const list = libFilter === 'all' ? [...library] : library.filter(v => v.assetType === libFilter);
        // 有镜头编号的按编号升序排前面，方便按顺序拖入时间轴；其余保持原顺序（按创建时间倒序）
        return list.sort((a, b) => shotNo(a) - shotNo(b));
    }, [library, libFilter]);

    // ---- 时间轴数据 ----
    const [clips, setClips] = useState<Clip[]>([]);
    const [transitions, setTransitions] = useState<Transition[]>([]);
    const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
    const [audios, setAudios] = useState<AudioItem[]>([]);
    const [stickers, setStickers] = useState<Sticker[]>([]);
    const [overlays, setOverlays] = useState<OverlayClip[]>([]);

    // ---- 选中与播放 ----
    const [selected, setSelected] = useState<{ kind: 'clip' | 'sub' | 'audio' | 'sticker' | 'overlay'; id: string } | null>(null);
    const [playhead, setPlayhead] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [pxPerSec, setPxPerSec] = useState(40);

    // ---- 时间轴面板高度（顶边可拖动调节；轨道多时内部上下滚动）----
    const [timelineH, setTimelineH] = useState(360);
    const tlResizeRef = useRef<{ startY: number; startH: number } | null>(null);
    const onTlResizeDown = (e: React.PointerEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        tlResizeRef.current = { startY: e.clientY, startH: timelineH };
    };
    const onTlResizeMove = (e: React.PointerEvent) => {
        const d = tlResizeRef.current;
        if (!d) return;
        const max = Math.round(window.innerHeight * 0.7);
        setTimelineH(Math.min(max, Math.max(160, d.startH + (d.startY - e.clientY))));
    };
    const onTlResizeUp = () => { tlResizeRef.current = null; };

    // ---- 轨道级静音 ----
    const [videoTrackMuted, setVideoTrackMuted] = useState(false);
    const [audioTrackMuted, setAudioTrackMuted] = useState(false);

    // ---- 多音轨（人声/背景声/BGM 等分轨；逐轨静音）----
    const [audioLaneCount, setAudioLaneCount] = useState(2);
    const [audioLaneMuted, setAudioLaneMuted] = useState<boolean[]>([]);
    // 有效音轨数：用户设置的轨道数与条目实际占用的最大轨道取大者
    const audioLanes = useMemo(
        () => Math.min(MAX_AUDIO_LANES, Math.max(1, audioLaneCount, ...audios.map(a => aTrack(a) + 1))),
        [audioLaneCount, audios]
    );
    /** 找一条在 [start, end) 时间段没有内容重叠的音轨；都被占用则返回新轨（不超上限） */
    const findFreeAudioLane = useCallback((start: number, end: number, minLane = 0): number => {
        for (let L = minLane; L < audioLanes; L++) {
            const overlap = audios.some(a => aTrack(a) === L && start < a.start + audioDur(a) && end > a.start);
            if (!overlap) return L;
        }
        return Math.min(MAX_AUDIO_LANES - 1, audioLanes);
    }, [audios, audioLanes]);

    // ---- 画中画轨道 ----
    const [overlayLaneCount, setOverlayLaneCount] = useState(1);
    const overlayLanes = useMemo(
        () => Math.min(MAX_OVERLAY_LANES, Math.max(1, overlayLaneCount, ...overlays.map(o => oTrack(o) + 1))),
        [overlayLaneCount, overlays]
    );
    /** 找一条在 [start, end) 没有画中画重叠的轨道，找不到返回第 0 轨 */
    const findFreeOverlayLane = useCallback((start: number, end: number): number => {
        for (let L = 0; L < overlayLanes; L++) {
            const overlap = overlays.some(o => oTrack(o) === L && start < o.start + clipDur(o) && end > o.start);
            if (!overlap) return L;
        }
        return overlayLanes < MAX_OVERLAY_LANES ? overlayLanes : 0;
    }, [overlays, overlayLanes]);

    // ---- 撤销 / 重做（历史栈，覆盖 片段/转场/字幕/音频 四类数据）----
    interface HistorySnapshot {
        clips: Clip[];
        transitions: Transition[];
        subtitles: SubtitleItem[];
        audios: AudioItem[];
        stickers: Sticker[];
        overlays: OverlayClip[];
    }
    const historyRef = useRef<HistorySnapshot[]>([]);
    const redoStackRef = useRef<HistorySnapshot[]>([]);
    const applyingHistoryRef = useRef(false);
    const [histVersion, setHistVersion] = useState(0); // 仅用于刷新按钮可用态

    // 状态变化后（防抖 400ms，合并拖拽/滑杆的连续变化）推入历史
    useEffect(() => {
        if (!isOpen) return;
        if (applyingHistoryRef.current) { applyingHistoryRef.current = false; return; }
        const t = setTimeout(() => {
            const snap: HistorySnapshot = structuredClone({ clips, transitions, subtitles, audios, stickers, overlays });
            const top = historyRef.current[historyRef.current.length - 1];
            if (top && JSON.stringify(top) === JSON.stringify(snap)) return; // 无实际变化
            historyRef.current.push(snap);
            if (historyRef.current.length > 60) historyRef.current.shift();
            redoStackRef.current = [];
            setHistVersion(v => v + 1);
        }, 400);
        return () => clearTimeout(t);
    }, [isOpen, clips, transitions, subtitles, audios, stickers, overlays]);

    const applySnapshot = (snap: HistorySnapshot) => {
        applyingHistoryRef.current = true;
        const s = structuredClone(snap);
        setClips(s.clips);
        setTransitions(s.transitions);
        setSubtitles(s.subtitles);
        setAudios(s.audios);
        setStickers(s.stickers || []);
        setOverlays(s.overlays || []);
        setSelected(null);
        currentClipIdxRef.current = -1;
        setHistVersion(v => v + 1);
    };

    const undo = () => {
        if (historyRef.current.length < 2) return;
        const cur = historyRef.current.pop()!;
        redoStackRef.current.push(cur);
        applySnapshot(historyRef.current[historyRef.current.length - 1]);
    };

    const redo = () => {
        const snap = redoStackRef.current.pop();
        if (!snap) return;
        historyRef.current.push(snap);
        applySnapshot(snap);
    };

    const canUndo = historyRef.current.length > 1;
    const canRedo = redoStackRef.current.length > 0;
    void histVersion; // 触发重渲染用

    // ---- 右侧面板 Tab（视频 / 文字 / 声音 / 贴纸 / 特效 / 转场）----
    const [panelTab, setPanelTab] = useState<'video' | 'text' | 'audio' | 'sticker' | 'fx' | 'trans'>('video');

    // 选中对象时自动切换到对应 Tab
    useEffect(() => {
        if (!selected) return;
        if (selected.kind === 'clip' || selected.kind === 'overlay') { if (panelTab !== 'fx' && panelTab !== 'trans') setPanelTab('video'); }
        else if (selected.kind === 'sub') setPanelTab('text');
        else if (selected.kind === 'sticker') setPanelTab('sticker');
        else setPanelTab('audio');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected]);

    // ---- 素材导入 ----
    const [importingVideo, setImportingVideo] = useState(false);
    const [importingMusic, setImportingMusic] = useState(false);
    const videoFileRef = useRef<HTMLInputElement>(null);
    const musicFileRef = useRef<HTMLInputElement>(null);

    // ---- 转场选择浮层（固定定位，避免被时间轴 overflow 裁剪）----
    const [transPickerIdx, setTransPickerIdx] = useState<number | null>(null);
    const [transPickerPos, setTransPickerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [transApplyAll, setTransApplyAll] = useState(false); // 转场 Tab：批量应用开关

    // ---- 字幕默认样式（新字幕/批量生成的字幕使用）----
    const [defaultStyle, setDefaultStyle] = useState<SubtitleStyle>({ ...DEFAULT_SUB_STYLE });

    // ---- 配音面板 ----
    const [voices, setVoices] = useState<VoiceOption[]>([]);
    const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural');
    const [script, setScript] = useState('');
    const [scriptPrompt, setScriptPrompt] = useState('');
    const [generatingScript, setGeneratingScript] = useState(false);
    const [generatingTTS, setGeneratingTTS] = useState(false);
    const [ttsProgress, setTtsProgress] = useState('');
    const [transcribing, setTranscribing] = useState(false); // 智能字幕识别中

    // ---- 导出 ----
    const [resolution, setResolution] = useState('1280x720');
    const [exporting, setExporting] = useState(false);
    const [exportUrl, setExportUrl] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // ---- 剪辑项目（保存当前剪辑状态 / 打开历史剪辑）----
    const [projects, setProjects] = useState<EditProjectMeta[]>([]);
    const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
    const [currentProjectName, setCurrentProjectName] = useState('');
    const [savingProject, setSavingProject] = useState(false);
    const [openingProject, setOpeningProject] = useState(false);

    // ---- refs ----
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const overlayElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
    const rafRef = useRef<number>(0);
    const lastTickRef = useRef(performance.now());
    const playheadRef = useRef(0);
    const playingRef = useRef(false);
    const currentClipIdxRef = useRef(-1);
    const timelineScrollRef = useRef<HTMLDivElement>(null);
    const videoWrapRef = useRef<HTMLDivElement>(null);
    const [videoBoxH, setVideoBoxH] = useState(360); // 预览视频实际显示高度（字幕字号按比例缩放）
    const [videoBoxW, setVideoBoxW] = useState(640); // 预览视频实际显示宽度（字幕最大宽度按比例换算）
    const previewAreaRef = useRef<HTMLDivElement>(null);
    const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 }); // 预览区可用尺寸

    // 最大化播放：把「预览 + 播放控制条」整列全屏（含贴纸/字幕叠加层），Esc 或再点一次退出
    const previewColRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);
    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => { });
        } else {
            previewColRef.current?.requestFullscreen().catch(() => { });
        }
    }, []);

    // ---- 预览转场（幽灵帧叠加）----
    const ghostCanvasRef = useRef<HTMLCanvasElement>(null);
    const imgPreviewRef = useRef<HTMLImageElement>(null);
    const transPreviewRef = useRef<{ type: string; duration: number; start: number; baseFilter: string; baseTransform: string } | null>(null);
    const [transPreview, setTransPreview] = useState<{ type: string; p: number; baseFilter: string; baseTransform: string } | null>(null);

    playheadRef.current = playhead;
    playingRef.current = playing;

    // ---- 派生数据：每个片段的全局起点（预览按硬切顺序铺开）----
    const clipStarts = useMemo(() => {
        const starts: number[] = [];
        let t = 0;
        for (const c of clips) {
            starts.push(t);
            t += clipDur(c);
        }
        return starts;
    }, [clips]);

    const totalDuration = useMemo(() => {
        const clipTotal = clips.reduce((s, c) => s + clipDur(c), 0);
        const audioEnd = audios.reduce((m, a) => Math.max(m, a.start + audioDur(a)), 0);
        const subEnd = subtitles.reduce((m, s) => Math.max(m, s.end), 0);
        const stkEnd = stickers.reduce((m, s) => Math.max(m, s.end), 0);
        const ovEnd = overlays.reduce((m, o) => Math.max(m, o.start + clipDur(o)), 0);
        return Math.max(clipTotal, audioEnd, subEnd, stkEnd, ovEnd, 1);
    }, [clips, audios, subtitles, stickers, overlays]);

    // ============================================================================
    // 数据加载
    // ============================================================================

    useEffect(() => {
        if (!isOpen) return;
        setLibLoading(true);
        Promise.all([
            fetch('/api/assets/videos').then(r => r.json()).catch(() => []),
            fetch('/api/assets/images').then(r => r.json()).catch(() => []),
        ])
            .then(([vids, imgs]) => {
                const vList = (Array.isArray(vids) ? vids : (vids.assets || [])).map((v: any) => ({ ...v, assetType: 'video' as const }));
                const iList = (Array.isArray(imgs) ? imgs : (imgs.assets || [])).map((v: any) => ({ ...v, assetType: 'image' as const }));
                const merged = [...vList, ...iList]
                    .filter((v: LibraryAsset) => v.url)
                    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
                setLibrary(merged);
            })
            .finally(() => setLibLoading(false));

        fetch('/api/video-studio/voices')
            .then(r => r.json())
            .then(d => { if (d.voices) setVoices(d.voices); })
            .catch(() => { /* 用默认音色 */ });

        refreshProjects();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    // ============================================================================
    // 剪辑项目：保存 / 打开历史 / 删除
    // ============================================================================

    const refreshProjects = useCallback(async () => {
        try {
            const r = await fetch('/api/edit-projects');
            if (r.ok) {
                const d = await r.json();
                setProjects(d.projects || []);
            }
        } catch { /* 列表加载失败不阻塞剪辑 */ }
    }, []);

    /** 保存当前剪辑工作区：已打开历史项目则覆盖，否则新建 */
    const handleSaveProject = useCallback(async () => {
        setSavingProject(true);
        try {
            const name = currentProjectName
                || `剪辑 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
            const data = {
                version: 1,
                clips, transitions, subtitles, audios, stickers, overlays,
                defaultStyle, resolution, voice, script,
                videoTrackMuted, audioTrackMuted,
                audioLaneCount: audioLanes, audioLaneMuted,
                overlayLaneCount: overlayLanes,
            };
            const r = await fetch('/api/edit-projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: currentProjectId || undefined, name, data }),
            });
            if (r.ok) {
                const d = await r.json();
                setCurrentProjectId(d.id);
                setCurrentProjectName(d.name);
                await refreshProjects();
            } else {
                setErrorMsg('保存剪辑失败');
            }
        } catch (e: any) {
            setErrorMsg(`保存剪辑失败：${e.message}`);
        } finally {
            setSavingProject(false);
        }
    }, [currentProjectId, currentProjectName, clips, transitions, subtitles, audios, stickers, overlays,
        defaultStyle, resolution, voice, script, videoTrackMuted, audioTrackMuted,
        audioLanes, audioLaneMuted, overlayLanes, refreshProjects]);

    /** 打开历史剪辑项目，恢复全部时间轴状态 */
    const handleOpenProject = useCallback(async (id: string) => {
        if (!id || id === currentProjectId) return;
        const hasContent = clips.length > 0 || subtitles.length > 0 || audios.length > 0 || stickers.length > 0;
        if (hasContent) {
            const ok = await showAppConfirm('打开历史剪辑会替换当前时间轴内容，未保存的修改将丢失。确定继续吗？', {
                title: '打开历史剪辑', confirmText: '打开', danger: true,
            });
            if (!ok) return;
        }
        setOpeningProject(true);
        try {
            const r = await fetch(`/api/edit-projects/${id}`);
            if (!r.ok) { setErrorMsg('加载剪辑失败'); return; }
            const p = await r.json();
            const d = p.data || {};
            setClips(Array.isArray(d.clips) ? d.clips : []);
            setTransitions(Array.isArray(d.transitions) ? d.transitions : []);
            setSubtitles(Array.isArray(d.subtitles) ? d.subtitles : []);
            setAudios(Array.isArray(d.audios) ? d.audios : []);
            setStickers(Array.isArray(d.stickers) ? d.stickers : []);
            setOverlays(Array.isArray(d.overlays) ? d.overlays : []);
            setOverlayLaneCount(Math.min(MAX_OVERLAY_LANES, Math.max(1, Number(d.overlayLaneCount) || 1)));
            if (d.defaultStyle) setDefaultStyle({ ...DEFAULT_SUB_STYLE, ...d.defaultStyle });
            if (d.resolution) setResolution(d.resolution);
            if (d.voice) setVoice(d.voice);
            if (typeof d.script === 'string') setScript(d.script);
            setVideoTrackMuted(!!d.videoTrackMuted);
            // 旧项目的「配音轨整体静音」映射为所有音轨静音（全局开关已由逐轨静音取代）
            const laneCount = Math.min(MAX_AUDIO_LANES, Math.max(1, Number(d.audioLaneCount) || 2));
            setAudioLaneCount(laneCount);
            setAudioLaneMuted(
                Array.isArray(d.audioLaneMuted) ? d.audioLaneMuted.map(Boolean)
                    : d.audioTrackMuted ? Array(laneCount).fill(true) : []
            );
            setAudioTrackMuted(false);
            // 重置播放与撤销历史（避免跨项目撤销）
            setSelected(null);
            setPlayhead(0);
            setPlaying(false);
            setExportUrl(null);
            setErrorMsg(null);
            historyRef.current = [];
            redoStackRef.current = [];
            setHistVersion(v => v + 1);
            setCurrentProjectId(p.id);
            setCurrentProjectName(p.name || '');
        } catch (e: any) {
            setErrorMsg(`加载剪辑失败：${e.message}`);
        } finally {
            setOpeningProject(false);
        }
    }, [currentProjectId, clips.length, subtitles.length, audios.length, stickers.length]);

    /** 删除当前打开的历史剪辑记录（不影响时间轴内容） */
    const handleDeleteProject = useCallback(async () => {
        if (!currentProjectId) return;
        const ok = await showAppConfirm(`确定删除剪辑记录「${currentProjectName || currentProjectId}」吗？时间轴当前内容不受影响。`, {
            title: '删除剪辑记录', confirmText: '删除', danger: true,
        });
        if (!ok) return;
        try {
            await fetch(`/api/edit-projects/${currentProjectId}`, { method: 'DELETE' });
            setCurrentProjectId(null);
            setCurrentProjectName('');
            await refreshProjects();
        } catch { /* 忽略 */ }
    }, [currentProjectId, currentProjectName, refreshProjects]);

    // 跟踪预览视频显示尺寸（字幕字号/位置按比例渲染）
    useEffect(() => {
        if (!isOpen || !videoWrapRef.current) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                if (e.contentRect.height > 0) setVideoBoxH(e.contentRect.height);
                if (e.contentRect.width > 0) setVideoBoxW(e.contentRect.width);
            }
        });
        ro.observe(videoWrapRef.current);
        return () => ro.disconnect();
    }, [isOpen, clips.length]);

    // 跟踪预览区可用尺寸（约束 video 元素，保证竖屏/横屏都完整显示）
    useEffect(() => {
        if (!isOpen || !previewAreaRef.current) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                setPreviewSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
            }
        });
        ro.observe(previewAreaRef.current);
        return () => ro.disconnect();
    }, [isOpen]);

    // ============================================================================
    // 播放控制（rAF 时钟驱动：视频切换 + 字幕 + 配音同步）
    // ============================================================================

    const findClipAt = useCallback((t: number): { idx: number; local: number } => {
        for (let i = 0; i < clips.length; i++) {
            const dur = clipDur(clips[i]);
            if (t < clipStarts[i] + dur || i === clips.length - 1) {
                return { idx: i, local: Math.min(Math.max(0, t - clipStarts[i]), dur) };
            }
        }
        return { idx: -1, local: 0 };
    }, [clips, clipStarts]);

    /** 让 video 元素对齐到全局时间 t（local 为时间轴时间，需乘 speed 映射到素材时间） */
    const syncVideoTo = useCallback((t: number, autoPlay: boolean) => {
        const video = videoRef.current;
        if (!video || clips.length === 0) return;
        const { idx, local } = findClipAt(t);
        if (idx < 0) return;
        const clip = clips[idx];

        // 图片片段：无需驱动 video，播放由 rAF 时钟推进
        if (clip.isImage) {
            currentClipIdxRef.current = idx;
            if (!video.paused) video.pause();
            return;
        }

        const targetSrc = clip.url.startsWith('http') ? clip.url : `${clip.url}`;

        const seekAndMaybePlay = () => {
            video.currentTime = clip.inPoint + local * clip.speed;
            video.playbackRate = clip.speed;
            video.muted = videoTrackMuted || clip.muted;
            video.volume = Math.min(1, clip.volume);
            if (autoPlay) video.play().catch(() => { });
        };

        if (currentClipIdxRef.current !== idx || !video.src.includes(encodeURI(clip.url).split('/').pop() || '###')) {
            currentClipIdxRef.current = idx;
            video.src = targetSrc;
            video.onloadedmetadata = seekAndMaybePlay;
        } else {
            seekAndMaybePlay();
        }
    }, [clips, findClipAt, videoTrackMuted]);

    /** 片段切换前：把当前帧绘制到幽灵画布，启动转场退场动画（导出 xfade 的近似预览） */
    const startTransPreview = useCallback((idx: number) => {
        if (idx < 0 || idx >= clips.length - 1) return;
        const tr = transitions[idx];
        if (!tr || tr.type === 'none') return;
        const clip = clips[idx];
        const srcEl: HTMLVideoElement | HTMLImageElement | null = clip.isImage ? imgPreviewRef.current : videoRef.current;
        const cv = ghostCanvasRef.current;
        if (!srcEl || !cv) return;
        const w = clip.isImage ? (srcEl as HTMLImageElement).naturalWidth : (srcEl as HTMLVideoElement).videoWidth;
        const h = clip.isImage ? (srcEl as HTMLImageElement).naturalHeight : (srcEl as HTMLVideoElement).videoHeight;
        if (!w || !h) return;
        cv.width = w;
        cv.height = h;
        try {
            cv.getContext('2d')?.drawImage(srcEl, 0, 0, w, h);
        } catch {
            return; // 绘制失败则跳过转场预览（不影响播放）
        }
        const fx = clip.effect ? FX_PRESETS.find(f => f.id === clip.effect) : null;
        const info = {
            type: tr.type,
            duration: Math.max(0.2, Math.min(Number(tr.duration) || 0.5, 2)),
            start: clipStarts[idx + 1] ?? playheadRef.current,
            baseFilter: `brightness(${(1 + clip.eq.brightness).toFixed(2)}) contrast(${clip.eq.contrast.toFixed(2)}) saturate(${clip.eq.saturation.toFixed(2)})${fx?.css ? ' ' + fx.css : ''}`,
            baseTransform: `translate(${(clip.posX * 100).toFixed(1)}%, ${(clip.posY * 100).toFixed(1)}%) rotate(${clip.rotate}deg) scaleX(${clip.flipH ? -clip.scale : clip.scale}) scaleY(${clip.flipV ? -clip.scale : clip.scale})`,
        };
        transPreviewRef.current = info;
        setTransPreview({ type: info.type, p: 0, baseFilter: info.baseFilter, baseTransform: info.baseTransform });
    }, [clips, transitions, clipStarts]);

    /** 每帧：推进播放头、处理片段切换、同步配音音频 */
    const tick = useCallback(() => {
        const video = videoRef.current;
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTickRef.current) / 1000);
        lastTickRef.current = now;

        if (playingRef.current && video && clips.length > 0) {
            const idx = currentClipIdxRef.current;
            if (idx >= 0 && idx < clips.length) {
                const clip = clips[idx];
                if (clip.isImage) {
                    // 图片片段：用墙钟推进播放头
                    const globalT = playheadRef.current + dt;
                    setPlayhead(globalT);
                    playheadRef.current = globalT;
                    if (globalT >= clipStarts[idx] + clipDur(clip) - 0.02) {
                        if (idx < clips.length - 1) {
                            startTransPreview(idx);
                            syncVideoTo(clipStarts[idx + 1] + 0.001, true);
                        } else {
                            setPlaying(false);
                            playingRef.current = false;
                        }
                    }
                } else {
                    const local = (video.currentTime - clip.inPoint) / clip.speed;
                    const globalT = clipStarts[idx] + Math.max(0, local);
                    setPlayhead(globalT);
                    playheadRef.current = globalT;

                    // 片段播完 → 下一段或停止
                    if (video.currentTime >= clip.outPoint - 0.03 || video.ended) {
                        if (idx < clips.length - 1) {
                            startTransPreview(idx);
                            syncVideoTo(clipStarts[idx + 1] + 0.001, true);
                        } else {
                            setPlaying(false);
                            playingRef.current = false;
                            video.pause();
                        }
                    }
                }
            }
        }

        // 配音/音乐同步（变速 + 静音）
        const t = playheadRef.current;
        audios.forEach(a => {
            const el = audioElsRef.current.get(a.id);
            if (!el) return;
            const effDur = audioDur(a);
            const inRange = t >= a.start && t < a.start + effDur;
            const isMuted = audioTrackMuted || a.muted || a.volume === 0 || !!audioLaneMuted[aTrack(a)];
            if (playingRef.current && inRange && !isMuted) {
                const want = a.inPoint + (t - a.start) * a.speed; // 映射回素材时间（含裁剪入点）
                el.playbackRate = a.speed;
                el.volume = Math.min(1, a.volume);
                if (el.paused) {
                    el.currentTime = want;
                    el.play().catch(() => { });
                } else if (Math.abs(el.currentTime - want) > 0.35) {
                    el.currentTime = want;
                }
            } else if (!el.paused) {
                el.pause();
            }
        });

        // 画中画视频同步（拖动播放头时也对齐画面帧）
        overlays.forEach(o => {
            if (o.isImage) return;
            const el = overlayElsRef.current.get(o.id);
            if (!el) return;
            const local = t - o.start;
            const inRange = local >= 0 && local < clipDur(o);
            const want = o.inPoint + Math.max(0, local) * o.speed;
            if (playingRef.current && inRange) {
                el.playbackRate = o.speed;
                el.muted = o.muted || videoTrackMuted;
                el.volume = Math.min(1, o.volume);
                if (el.paused) {
                    el.currentTime = want;
                    el.play().catch(() => { });
                } else if (Math.abs(el.currentTime - want) > 0.35) {
                    el.currentTime = want;
                }
            } else {
                if (!el.paused) el.pause();
                // 暂停状态下拖播放头：对齐当前帧
                if (!playingRef.current && inRange && Math.abs(el.currentTime - want) > 0.2) {
                    el.currentTime = want;
                }
            }
        });

        // 预览转场进度推进
        const tp = transPreviewRef.current;
        if (tp) {
            const p = (playheadRef.current - tp.start) / tp.duration;
            if (!playingRef.current || p >= 1) {
                transPreviewRef.current = null;
                setTransPreview(null);
            } else {
                setTransPreview({ type: tp.type, p: Math.max(0, p), baseFilter: tp.baseFilter, baseTransform: tp.baseTransform });
            }
        }

        rafRef.current = requestAnimationFrame(tick);
    }, [clips, clipStarts, audios, overlays, syncVideoTo, audioTrackMuted, audioLaneMuted, videoTrackMuted, startTransPreview]);

    useEffect(() => {
        if (!isOpen) return;
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [isOpen, tick]);

    const handlePlayPause = () => {
        if (clips.length === 0) return;
        if (playing) {
            setPlaying(false);
            videoRef.current?.pause();
        } else {
            let t = playheadRef.current;
            const clipTotal = clips.reduce((s, c) => s + clipDur(c), 0);
            if (t >= clipTotal - 0.05) t = 0; // 播完后从头开始
            setPlaying(true);
            playingRef.current = true;
            syncVideoTo(t, true);
        }
    };

    const seekTo = (t: number) => {
        const clamped = Math.max(0, Math.min(t, totalDuration));
        setPlayhead(clamped);
        playheadRef.current = clamped;
        // 手动跳转取消转场预览动画
        transPreviewRef.current = null;
        setTransPreview(null);
        syncVideoTo(clamped, playingRef.current);
    };

    // ============================================================================
    // 时间轴操作
    // ============================================================================

    const buildClip = (v: LibraryAsset, sourceDuration: number, outPoint: number, isImage: boolean): Clip => ({
        id: uid(),
        url: v.url,
        name: (v.title || v.prompt || (isImage ? '图片' : '视频片段')).slice(0, 20),
        sourceDuration,
        inPoint: 0,
        outPoint,
        speed: 1,
        muted: false,
        volume: 1,
        reverse: false,
        rotate: 0 as const,
        flipH: false,
        flipV: false,
        eq: { ...DEFAULT_EQ },
        scale: 1,
        posX: 0,
        posY: 0,
        effect: null,
        isImage,
    });

    const appendClip = (clip: Clip) => {
        setClips(prev => {
            const next = [...prev, clip];
            setTransitions(tp => next.length > 1 ? [...tp, { type: 'none', duration: 0.5 }].slice(0, next.length - 1) : tp);
            return next;
        });
    };

    const addClipFromLibrary = (v: LibraryAsset) => {
        if (v.assetType === 'image') {
            // 图片：默认展示 4 秒，出点可拉长到 600 秒
            appendClip(buildClip(v, 600, 4, true));
            return;
        }
        // 视频：用临时 video 元素探测素材时长
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.src = v.url.startsWith('http') ? v.url : `${v.url}`;
        probe.onloadedmetadata = () => {
            const dur = isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 5;
            appendClip(buildClip(v, dur, dur, false));
        };
        probe.onerror = () => setErrorMsg('素材加载失败，无法添加');
    };

    // ---- 一键添加：当前筛选下的全部素材按列表顺序（镜头编号升序）依次加入时间轴 ----
    const [addingAll, setAddingAll] = useState(false);

    /** 探测视频素材时长（秒），失败返回 0 */
    const probeVideoDuration = (url: string): Promise<number> => new Promise(resolve => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.src = url;
        probe.onloadedmetadata = () => resolve(isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 5);
        probe.onerror = () => resolve(0);
    });

    const handleAddAllToTimeline = async () => {
        if (addingAll || filteredLibrary.length === 0) return;
        setAddingAll(true);
        setErrorMsg(null);
        try {
            // 并行探测全部视频时长，再按列表顺序一次性追加（保证镜头顺序）
            const durations = await Promise.all(filteredLibrary.map(v =>
                v.assetType === 'image' ? Promise.resolve(4) : probeVideoDuration(v.url.startsWith('http') ? v.url : `${v.url}`)
            ));
            const newClips: Clip[] = [];
            let failed = 0;
            filteredLibrary.forEach((v, i) => {
                if (v.assetType === 'image') {
                    newClips.push(buildClip(v, 600, 4, true));
                } else if (durations[i] > 0) {
                    newClips.push(buildClip(v, durations[i], durations[i], false));
                } else {
                    failed++;
                }
            });
            if (newClips.length > 0) {
                setClips(prev => {
                    const next = [...prev, ...newClips];
                    setTransitions(tp => {
                        const need = Math.max(0, next.length - 1);
                        const arr = [...tp];
                        while (arr.length < need) arr.push({ type: 'none', duration: 0.5 });
                        return arr.slice(0, need);
                    });
                    return next;
                });
            }
            if (failed > 0) setErrorMsg(`${failed} 个素材加载失败，已跳过`);
        } finally {
            setAddingAll(false);
        }
    };

    /** 删除一组素材文件（逐个调用后端） */
    const removeAssets = async (list: LibraryAsset[]) => {
        setLibDeleting(true);
        setErrorMsg(null);
        let failed = 0;
        for (const v of list) {
            try {
                const type = v.assetType === 'image' ? 'images' : 'videos';
                const res = await fetch(`/api/assets/${type}/${v.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error();
                setLibrary(prev => prev.filter(x => !(x.id === v.id && x.assetType === v.assetType)));
            } catch (_) {
                failed++;
            }
        }
        setLibDeleting(false);
        setLibSelected(new Set());
        if (failed > 0) setErrorMsg(`${failed} 个素材删除失败`);
    };

    /** 删除单个素材 */
    const deleteLibraryAsset = async (e: React.MouseEvent, v: LibraryAsset) => {
        e.stopPropagation();
        const ok = await showAppConfirm('确定删除该素材吗？文件将从素材库中移除。', { title: '删除素材', confirmText: '删除', danger: true });
        if (!ok) return;
        await removeAssets([v]);
    };

    /** 批量删除勾选的素材 */
    const handleBatchDelete = async () => {
        const list = library.filter(v => libSelected.has(`${v.assetType}_${v.id}`));
        if (list.length === 0) return;
        const ok = await showAppConfirm(`确定删除选中的 ${list.length} 个素材吗？文件将从素材库中移除。`, { title: '批量删除素材', confirmText: '删除', danger: true });
        if (!ok) return;
        await removeAssets(list);
        setLibSelectMode(false);
    };

    /** 清空素材库 */
    const handleClearLibrary = async () => {
        if (library.length === 0) return;
        const ok = await showAppConfirm(`确定清空素材库吗？将删除全部 ${library.length} 个素材文件，且无法恢复。`, { title: '清空素材库', confirmText: '清空', danger: true });
        if (!ok) return;
        await removeAssets([...library]);
        setLibSelectMode(false);
    };

    /** 勾选/取消勾选素材 */
    const toggleLibSelect = (v: LibraryAsset) => {
        const k = `${v.assetType}_${v.id}`;
        setLibSelected(prev => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k); else next.add(k);
            return next;
        });
    };

    /** 批量导入本地视频/图片文件到素材库（文件选择和拖放共用） */
    const importMediaFiles = async (allFiles: File[]) => {
        const files = allFiles.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
        const skipped = allFiles.length - files.length;
        if (files.length === 0) {
            if (skipped > 0) setErrorMsg('仅支持视频 / 图片文件');
            return;
        }
        setImportingVideo(true);
        setErrorMsg(null);
        let failed = 0;
        for (const file of files) {
            const isImage = file.type.startsWith('image/');
            try {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result as string);
                    fr.onerror = reject;
                    fr.readAsDataURL(file);
                });
                const res = await fetch(`/api/assets/${isImage ? 'images' : 'videos'}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: dataUrl, prompt: file.name.replace(/\.[^.]+$/, '') }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '导入失败');
                setLibrary(prev => [{ id: data.id, url: data.url, prompt: file.name, assetType: isImage ? 'image' : 'video' } as LibraryAsset, ...prev]);
            } catch (_) {
                failed++;
            }
        }
        const tips: string[] = [];
        if (failed > 0) tips.push(`${failed} 个文件导入失败`);
        if (skipped > 0) tips.push(`${skipped} 个非视频/图片文件已忽略`);
        if (tips.length > 0) setErrorMsg(tips.join('，'));
        setImportingVideo(false);
    };

    const handleImportVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        await importMediaFiles(Array.from(e.target.files || []));
        if (videoFileRef.current) videoFileRef.current.value = '';
    };

    /** 素材库拖放导入 */
    const [libDragOver, setLibDragOver] = useState(false);
    const handleLibDragOver = (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setLibDragOver(true);
    };
    const handleLibDragLeave = (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setLibDragOver(false);
    };
    const handleLibDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setLibDragOver(false);
        await importMediaFiles(Array.from(e.dataTransfer.files || []));
    };

    /** 导入本地音乐到配音轨（从播放头处开始） */
    const handleImportMusicFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setImportingMusic(true);
        setErrorMsg(null);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result as string);
                fr.onerror = reject;
                fr.readAsDataURL(file);
            });
            const res = await fetch('/api/video-studio/upload-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, dataBase64: dataUrl }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '音乐导入失败');
            const item: AudioItem = {
                id: uid(), url: data.url, text: `🎵 ${file.name}`, start: playheadRef.current,
                duration: data.duration, inPoint: 0, outPoint: data.duration,
                volume: 0.8, muted: false, speed: 1, fadeIn: 0, fadeOut: 0, isMusic: true,
                // 音乐优先放音轨 2 之后的空闲轨道（音轨 1 留给人声/配音）
                track: findFreeAudioLane(playheadRef.current, playheadRef.current + data.duration, 1),
            };
            setAudios(prev => [...prev, item]);
            setSelected({ kind: 'audio', id: item.id });
        } catch (err: any) {
            setErrorMsg(err.message || '音乐导入失败');
        } finally {
            setImportingMusic(false);
            if (musicFileRef.current) musicFileRef.current.value = '';
        }
    };

    /** 在播放头处分割：选中音频则分割音频，否则分割视频片段（剪映「分割」） */
    const splitAtPlayhead = () => {
        const t = playheadRef.current;

        // 选中音频 → 分割该音频条目
        if (selected?.kind === 'audio') {
            const a = audios.find(x => x.id === selected.id);
            if (!a) return;
            const effDur = audioDur(a);
            if (t <= a.start + 0.1 || t >= a.start + effDur - 0.1) {
                setErrorMsg('播放头不在该音频内部，或太靠近边缘');
                return;
            }
            const srcSplit = a.inPoint + (t - a.start) * a.speed; // 素材内分割点
            const left: AudioItem = { ...a, id: uid(), outPoint: srcSplit, fadeOut: 0 };
            const right: AudioItem = { ...a, id: uid(), inPoint: srcSplit, start: t, fadeIn: 0 };
            setAudios(prev => {
                const i = prev.findIndex(x => x.id === a.id);
                const next = [...prev];
                next.splice(i, 1, left, right);
                return next;
            });
            setSelected({ kind: 'audio', id: right.id });
            return;
        }

        // 默认 → 分割播放头所在的视频片段
        const { idx, local } = findClipAt(t);
        if (idx < 0) return;
        const clip = clips[idx];
        const srcSplit = clip.inPoint + local * clip.speed; // 素材内的分割点
        if (srcSplit - clip.inPoint < 0.2 || clip.outPoint - srcSplit < 0.2) {
            setErrorMsg('分割点太靠近片段边缘');
            return;
        }
        const left: Clip = { ...clip, id: uid(), outPoint: srcSplit };
        const right: Clip = { ...clip, id: uid(), inPoint: srcSplit };
        setClips(prev => {
            const next = [...prev];
            next.splice(idx, 1, left, right);
            return next;
        });
        setTransitions(prev => {
            const next = [...prev];
            next.splice(idx, 0, { type: 'none', duration: 0.5 }); // 分割处硬切
            return next;
        });
        setSelected({ kind: 'clip', id: right.id });
        currentClipIdxRef.current = -1;
    };

    /** 从素材库添加画中画：默认放到播放头处的空闲画中画轨（40% 宽、右上角）；可指定落点时间与轨道（拖拽放置） */
    const addOverlayFromLibrary = (v: LibraryAsset, at?: { start: number; track: number }) => {
        const t = at ? Math.max(0, at.start) : playheadRef.current;
        const make = (sourceDuration: number, outPoint: number, isImage: boolean) => {
            const base = buildClip(v, sourceDuration, outPoint, isImage);
            const item: OverlayClip = {
                ...base,
                scale: 0.4, posX: 0.28, posY: -0.26,
                start: t,
                track: at ? Math.min(MAX_OVERLAY_LANES - 1, Math.max(0, at.track)) : findFreeOverlayLane(t, t + outPoint),
            };
            setOverlays(prev => [...prev, item]);
            setSelected({ kind: 'overlay', id: item.id });
        };
        if (v.assetType === 'image') { make(600, 4, true); return; }
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.src = v.url.startsWith('http') ? v.url : `${v.url}`;
        probe.onloadedmetadata = () => {
            const dur = isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 5;
            make(dur, dur, false);
        };
        probe.onerror = () => setErrorMsg('素材加载失败，无法添加画中画');
    };

    /** 把主轨视频片段转为画中画（保留裁剪/变速，从原全局时间点开始） */
    const convertClipToOverlay = (clipId: string) => {
        const idx = clips.findIndex(c => c.id === clipId);
        if (idx < 0) return;
        const c = clips[idx];
        const start = clipStarts[idx];
        const item: OverlayClip = {
            ...structuredClone(c),
            id: uid(),
            scale: 0.4, posX: 0.28, posY: -0.26,
            start,
            track: findFreeOverlayLane(start, start + clipDur(c)),
        };
        removeClip(clipId);
        setOverlays(prev => [...prev, item]);
        setSelected({ kind: 'overlay', id: item.id });
    };

    /** 分离音频：把视频片段的原声提取为独立音频条目（放到空闲音轨），片段本身静音 */
    const detachAudioFromClip = (clipId: string) => {
        const idx = clips.findIndex(c => c.id === clipId);
        if (idx < 0) return;
        const c = clips[idx];
        if (c.isImage) { setErrorMsg('图片片段没有音频可分离'); return; }
        const start = clipStarts[idx];
        const lane = findFreeAudioLane(start, start + clipDur(c));
        const item: AudioItem = {
            id: uid(),
            url: c.url,
            text: `🎬 ${c.name} 原声`,
            start,
            duration: c.sourceDuration,
            inPoint: c.inPoint,
            outPoint: c.outPoint,
            volume: c.volume,
            muted: false,
            speed: c.speed,
            fadeIn: 0,
            fadeOut: 0,
            track: lane,
        };
        updateClip(clipId, { muted: true });
        setAudios(prev => [...prev, item]);
        setSelected({ kind: 'audio', id: item.id });
    };

    /** 复制片段（插入到原片段之后） */
    const duplicateClip = (id: string) => {
        setClips(prev => {
            const idx = prev.findIndex(c => c.id === id);
            if (idx < 0) return prev;
            const copy: Clip = { ...prev[idx], id: uid() };
            const next = [...prev];
            next.splice(idx + 1, 0, copy);
            return next;
        });
        setTransitions(prev => {
            const idx = clips.findIndex(c => c.id === id);
            const next = [...prev];
            next.splice(Math.max(0, idx), 0, { type: 'none', duration: 0.5 });
            return next;
        });
        currentClipIdxRef.current = -1;
    };

    const removeClip = (id: string) => {
        setClips(prev => {
            const idx = prev.findIndex(c => c.id === id);
            const next = prev.filter(c => c.id !== id);
            setTransitions(tp => {
                const t = [...tp];
                if (idx > 0) t.splice(idx - 1, 1); else t.splice(0, 1);
                return t.slice(0, Math.max(0, next.length - 1));
            });
            return next;
        });
        if (selected?.id === id) setSelected(null);
        currentClipIdxRef.current = -1;
    };

    const moveClip = (id: string, dir: -1 | 1) => {
        setClips(prev => {
            const idx = prev.findIndex(c => c.id === id);
            const to = idx + dir;
            if (idx < 0 || to < 0 || to >= prev.length) return prev;
            const next = [...prev];
            [next[idx], next[to]] = [next[to], next[idx]];
            return next;
        });
        currentClipIdxRef.current = -1;
    };

    const updateClip = (id: string, patch: Partial<Clip>) => {
        setClips(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
        currentClipIdxRef.current = -1;
    };

    const addSubtitleAtPlayhead = () => {
        const s: SubtitleItem = { id: uid(), text: '双击编辑字幕', start: playheadRef.current, end: playheadRef.current + 2, style: { ...defaultStyle } };
        setSubtitles(prev => [...prev, s].sort((a, b) => a.start - b.start));
        setSelected({ kind: 'sub', id: s.id });
    };

    /** 更新某条字幕的样式 */
    const patchSubStyle = (id: string, patch: Partial<SubtitleStyle>) => {
        setSubtitles(prev => prev.map(s => s.id === id ? { ...s, style: { ...s.style, ...patch } } : s));
    };

    /** 把某条字幕的样式应用到全部字幕（剪映「应用到全部字幕」） */
    const applyStyleToAll = (id: string) => {
        const src = subtitles.find(s => s.id === id);
        if (!src) return;
        const st = { ...src.style };
        setSubtitles(prev => prev.map(s => ({ ...s, style: { ...st } })));
        setDefaultStyle({ ...st });
    };

    // ---- 时间轴多选（Ctrl+A 全选 / 空白处按住拖动框选 / Ctrl+点击加选）----
    const [multiSel, setMultiSel] = useState<Set<string>>(new Set()); // key: `${kind}:${id}`
    const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    const marqueeRef = useRef<{ x0: number; y0: number } | null>(null);

    /** 选中全部时间轴元素（视频/配音/字幕/贴纸） */
    const selectAllTimeline = () => {
        const all = new Set<string>();
        clips.forEach(c => all.add(`clip:${c.id}`));
        audios.forEach(a => all.add(`audio:${a.id}`));
        subtitles.forEach(s => all.add(`sub:${s.id}`));
        stickers.forEach(s => all.add(`sticker:${s.id}`));
        overlays.forEach(o => all.add(`overlay:${o.id}`));
        setMultiSel(all);
    };

    /** 框选命中计算：行高与时间轴渲染保持一致（标尺 24px + 每轨 48px + 添加音轨行 24px） */
    const computeMarqueeSelection = (x: number, y: number, w: number, h: number) => {
        const sel = new Set<string>();
        const xs = x, xe = x + w, ys = y, ye = y + h;
        const hitRow = (top: number, bottom: number) => ye > top && ys < bottom;
        const overlayTop = 72;                                   // 标尺 24 + 视频轨 48
        const audioTop = overlayTop + overlayLanes * 48;         // 画中画轨 N 条
        const subTop = audioTop + audioLanes * 48 + 24;          // 音轨 N 条 + 「添加音轨」行
        const stickerTop = subTop + 48;
        if (hitRow(24, 72)) {
            let cx = 0;
            for (const c of clips) {
                const cw = Math.max(clipDur(c) * pxPerSec, 30);
                if (xe > cx && xs < cx + cw) sel.add(`clip:${c.id}`);
                cx += cw;
            }
        }
        overlays.forEach(o => {
            const top = overlayTop + oTrack(o) * 48;
            if (!hitRow(top, top + 48)) return;
            const l = o.start * pxPerSec, iw = Math.max(clipDur(o) * pxPerSec, 24);
            if (xe > l && xs < l + iw) sel.add(`overlay:${o.id}`);
        });
        audios.forEach(a => {
            const top = audioTop + aTrack(a) * 48;
            if (!hitRow(top, top + 48)) return;
            const l = a.start * pxPerSec, iw = Math.max(audioDur(a) * pxPerSec, 24);
            if (xe > l && xs < l + iw) sel.add(`audio:${a.id}`);
        });
        if (hitRow(subTop, subTop + 48)) subtitles.forEach(s => {
            const l = s.start * pxPerSec, iw = Math.max((s.end - s.start) * pxPerSec, 24);
            if (xe > l && xs < l + iw) sel.add(`sub:${s.id}`);
        });
        if (hitRow(stickerTop, stickerTop + 48)) stickers.forEach(s => {
            const l = s.start * pxPerSec, iw = Math.max((s.end - s.start) * pxPerSec, 24);
            if (xe > l && xs < l + iw) sel.add(`sticker:${s.id}`);
        });
        return sel;
    };

    /** 批量删除多选元素（撤销栈自动记录） */
    const deleteMultiSelected = () => {
        if (multiSel.size === 0) return;
        const has = (k: string, id: string) => multiSel.has(`${k}:${id}`);
        setClips(prev => {
            const keep = prev.filter(c => !has('clip', c.id));
            if (keep.length !== prev.length) setTransitions(tp => tp.slice(0, Math.max(0, keep.length - 1)));
            return keep;
        });
        setAudios(prev => prev.filter(a => !has('audio', a.id)));
        setSubtitles(prev => prev.filter(s => !has('sub', s.id)));
        setStickers(prev => prev.filter(s => !has('sticker', s.id)));
        setOverlays(prev => prev.filter(o => !has('overlay', o.id)));
        if (selected && multiSel.has(`${selected.kind}:${selected.id}`)) setSelected(null);
        setMultiSel(new Set());
        currentClipIdxRef.current = -1;
    };

    // ---- 拖拽（配音/字幕/贴纸/画中画块水平移动；音频/画中画块可上下拖动换轨；多选时整组移动）----
    type DragKind = 'sub' | 'audio' | 'sticker' | 'overlay';
    const dragRef = useRef<{
        kind: DragKind; id: string; startX: number; orig: number;
        startY?: number; origTrack?: number;
        group?: { kind: DragKind; id: string; orig: number }[];
    } | null>(null);

    const onItemPointerDown = (e: React.PointerEvent, kind: DragKind, id: string, origStart: number) => {
        e.stopPropagation();
        const key = `${kind}:${id}`;
        // Ctrl+点击：切换该项的多选状态，不进入拖动
        if (e.ctrlKey || e.metaKey) {
            setMultiSel(prev => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
            });
            return;
        }
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        // 拖动多选成员 → 整组移动（仅时间可移的轨道；视频片段是顺序排列不参与）
        let group: { kind: DragKind; id: string; orig: number }[] | undefined;
        if (multiSel.has(key) && multiSel.size > 1) {
            group = [
                ...audios.filter(a => multiSel.has(`audio:${a.id}`)).map(a => ({ kind: 'audio' as const, id: a.id, orig: a.start })),
                ...subtitles.filter(s => multiSel.has(`sub:${s.id}`)).map(s => ({ kind: 'sub' as const, id: s.id, orig: s.start })),
                ...stickers.filter(s => multiSel.has(`sticker:${s.id}`)).map(s => ({ kind: 'sticker' as const, id: s.id, orig: s.start })),
                ...overlays.filter(o => multiSel.has(`overlay:${o.id}`)).map(o => ({ kind: 'overlay' as const, id: o.id, orig: o.start })),
            ];
        } else if (!multiSel.has(key) && multiSel.size > 0) {
            setMultiSel(new Set()); // 点击未选中的项 → 退出多选
        }
        dragRef.current = {
            kind, id, startX: e.clientX, orig: origStart, group,
            startY: e.clientY,
            origTrack:
                kind === 'audio' ? aTrack(audios.find(a => a.id === id) || ({} as AudioItem))
                    : kind === 'overlay' ? oTrack(overlays.find(o => o.id === id) || ({} as OverlayClip))
                        : 0,
        };
        setSelected({ kind, id });
    };

    const onItemPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const delta = (e.clientX - d.startX) / pxPerSec;
        // 整组移动：以最早的元素不越过 0 为限
        if (d.group && d.group.length > 0) {
            const minOrig = Math.min(...d.group.map(g => g.orig));
            const del = Math.max(delta, -minOrig);
            const find = (kind: string, id: string) => d.group!.find(g => g.kind === kind && g.id === id);
            setAudios(prev => prev.map(a => { const g = find('audio', a.id); return g ? { ...a, start: g.orig + del } : a; }));
            setSubtitles(prev => prev.map(s => { const g = find('sub', s.id); return g ? { ...s, start: g.orig + del, end: g.orig + del + (s.end - s.start) } : s; }));
            setStickers(prev => prev.map(s => { const g = find('sticker', s.id); return g ? { ...s, start: g.orig + del, end: g.orig + del + (s.end - s.start) } : s; }));
            setOverlays(prev => prev.map(o => { const g = find('overlay', o.id); return g ? { ...o, start: g.orig + del } : o; }));
            return;
        }
        const newStart = Math.max(0, d.orig + delta);
        if (d.kind === 'audio') {
            // 垂直拖动跨音轨（每轨 56px）
            const laneDelta = Math.round((e.clientY - (d.startY ?? e.clientY)) / 48);
            const newTrack = Math.min(audioLanes - 1, Math.max(0, (d.origTrack ?? 0) + laneDelta));
            setAudios(prev => prev.map(a => a.id === d.id ? { ...a, start: newStart, track: newTrack } : a));
        } else if (d.kind === 'overlay') {
            const laneDelta = Math.round((e.clientY - (d.startY ?? e.clientY)) / 48);
            const newTrack = Math.min(overlayLanes - 1, Math.max(0, (d.origTrack ?? 0) + laneDelta));
            setOverlays(prev => prev.map(o => o.id === d.id ? { ...o, start: newStart, track: newTrack } : o));
        } else if (d.kind === 'sticker') {
            setStickers(prev => prev.map(s => s.id === d.id ? { ...s, start: newStart, end: newStart + (s.end - s.start) } : s));
        } else {
            setSubtitles(prev => prev.map(s => s.id === d.id ? { ...s, start: newStart, end: newStart + (s.end - s.start) } : s));
        }
    };

    const onItemPointerUp = () => { dragRef.current = null; };

    // ---- 字幕块边缘拖拽（调整开始/结束时间）----
    const subTrimRef = useRef<{ id: string; edge: 'L' | 'R'; startX: number; origStart: number; origEnd: number } | null>(null);

    const onSubTrimDown = (e: React.PointerEvent, s: SubtitleItem, edge: 'L' | 'R') => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        subTrimRef.current = { id: s.id, edge, startX: e.clientX, origStart: s.start, origEnd: s.end };
        setSelected({ kind: 'sub', id: s.id });
    };

    const onSubTrimMove = (e: React.PointerEvent) => {
        const d = subTrimRef.current;
        if (!d) return;
        const dSec = (e.clientX - d.startX) / pxPerSec;
        if (d.edge === 'L') {
            const ns = Math.min(Math.max(0, d.origStart + dSec), d.origEnd - 0.2);
            setSubtitles(prev => prev.map(s => s.id === d.id ? { ...s, start: ns } : s));
        } else {
            const ne = Math.max(d.origEnd + dSec, d.origStart + 0.2);
            setSubtitles(prev => prev.map(s => s.id === d.id ? { ...s, end: ne } : s));
        }
    };

    const onSubTrimUp = () => { subTrimRef.current = null; };

    // ---- 音频块边缘拖拽（裁剪入点/出点）----
    const audioTrimRef = useRef<{ id: string; edge: 'L' | 'R'; startX: number; origStart: number; origIn: number; origOut: number } | null>(null);

    const onAudioTrimDown = (e: React.PointerEvent, a: AudioItem, edge: 'L' | 'R') => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        audioTrimRef.current = { id: a.id, edge, startX: e.clientX, origStart: a.start, origIn: a.inPoint, origOut: a.outPoint };
        setSelected({ kind: 'audio', id: a.id });
    };

    const onAudioTrimMove = (e: React.PointerEvent) => {
        const d = audioTrimRef.current;
        if (!d) return;
        const a = audios.find(x => x.id === d.id);
        if (!a) return;
        const dxSec = (e.clientX - d.startX) / pxPerSec;     // 时间轴秒
        const dSrc = dxSec * a.speed;                          // 素材秒
        if (d.edge === 'L') {
            // 左边缘：同时移动 start 与入点（裁掉开头）
            const newIn = Math.min(Math.max(0, d.origIn + dSrc), d.origOut - 0.1);
            const actualDelta = (newIn - d.origIn) / a.speed;
            setAudios(prev => prev.map(x => x.id === d.id ? { ...x, inPoint: newIn, start: Math.max(0, d.origStart + actualDelta) } : x));
        } else {
            const newOut = Math.max(Math.min(a.duration, d.origOut + dSrc), d.origIn + 0.1);
            setAudios(prev => prev.map(x => x.id === d.id ? { ...x, outPoint: newOut } : x));
        }
    };

    const onAudioTrimUp = () => { audioTrimRef.current = null; };

    // ---- 画中画块边缘拖拽（裁剪入点/出点）----
    const overlayTrimRef = useRef<{ id: string; edge: 'L' | 'R'; startX: number; origStart: number; origIn: number; origOut: number } | null>(null);

    const onOverlayTrimDown = (e: React.PointerEvent, o: OverlayClip, edge: 'L' | 'R') => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        overlayTrimRef.current = { id: o.id, edge, startX: e.clientX, origStart: o.start, origIn: o.inPoint, origOut: o.outPoint };
        setSelected({ kind: 'overlay', id: o.id });
    };

    const onOverlayTrimMove = (e: React.PointerEvent) => {
        const d = overlayTrimRef.current;
        if (!d) return;
        const o = overlays.find(x => x.id === d.id);
        if (!o) return;
        const dSrc = ((e.clientX - d.startX) / pxPerSec) * o.speed; // 素材秒
        if (d.edge === 'L') {
            const newIn = Math.min(Math.max(0, d.origIn + dSrc), d.origOut - 0.2);
            const actualDelta = (newIn - d.origIn) / o.speed;
            setOverlays(prev => prev.map(x => x.id === d.id ? { ...x, inPoint: newIn, start: Math.max(0, d.origStart + actualDelta) } : x));
        } else {
            const maxOut = o.isImage ? 600 : o.sourceDuration;
            const newOut = Math.max(Math.min(maxOut, d.origOut + dSrc), d.origIn + 0.2);
            setOverlays(prev => prev.map(x => x.id === d.id ? { ...x, outPoint: newOut } : x));
        }
    };

    const onOverlayTrimUp = () => { overlayTrimRef.current = null; };

    // ---- 时间轴空白区域：标尺区点击/拖动刷播放头；轨道空白区点击定位、按住拖动 = 框选 ----
    const scrubbingRef = useRef(false);

    const onTimelinePointerDown = (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        seekTo(x / pxPerSec);
        if (y <= 24) {
            scrubbingRef.current = true; // 标尺区：继续拖动刷播放头
        } else {
            marqueeRef.current = { x0: x, y0: y }; // 轨道空白区：拖动进入框选
        }
    };

    const onTimelinePointerMove = (e: React.PointerEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (scrubbingRef.current) {
            seekTo(x / pxPerSec);
            return;
        }
        const m = marqueeRef.current;
        if (!m) return;
        if (!marquee && Math.abs(x - m.x0) < 5 && Math.abs(y - m.y0) < 5) return; // 拖动阈值
        const r = { x: Math.min(m.x0, x), y: Math.min(m.y0, y), w: Math.abs(x - m.x0), h: Math.abs(y - m.y0) };
        setMarquee(r);
        setMultiSel(computeMarqueeSelection(r.x, r.y, r.w, r.h));
    };

    const onTimelinePointerUp = () => {
        scrubbingRef.current = false;
        if (marqueeRef.current && !marquee) setMultiSel(new Set()); // 单击空白：清除多选
        marqueeRef.current = null;
        setMarquee(null);
    };

    // ---- 时间轴滚轮缩放（以鼠标位置为中心；Shift+滚轮 = 横向滚动）----
    const pxPerSecRef = useRef(pxPerSec);
    pxPerSecRef.current = pxPerSec;

    useEffect(() => {
        if (!isOpen) return;
        const el = timelineScrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.shiftKey) return; // Shift+滚轮保留为横向滚动
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const cur = pxPerSecRef.current;
            const anchorTime = (el.scrollLeft + offsetX) / cur; // 光标下的时间点
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const next = Math.min(200, Math.max(2, cur * factor));
            if (Math.abs(next - cur) < 0.01) return;
            setPxPerSec(next);
            // 缩放后保持光标下的时间点位置不变
            requestAnimationFrame(() => {
                el.scrollLeft = Math.max(0, anchorTime * next - offsetX);
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [isOpen]);

    // ---- 时间轴片段：拖拽排序 + 边缘裁剪（剪映式）----
    const clipDragRef = useRef<{
        mode: 'move' | 'trimL' | 'trimR';
        id: string;
        startX: number;
        origIn: number;
        origOut: number;
        moved: boolean;
    } | null>(null);
    const [clipDragOffset, setClipDragOffset] = useState<{ id: string; dx: number } | null>(null);

    const onClipPointerDown = (e: React.PointerEvent, c: Clip, mode: 'move' | 'trimL' | 'trimR') => {
        e.stopPropagation();
        // Ctrl+点击：切换片段多选状态，不进入拖动
        if (mode === 'move' && (e.ctrlKey || e.metaKey)) {
            setMultiSel(prev => {
                const next = new Set(prev);
                const key = `clip:${c.id}`;
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
            });
            return;
        }
        if (multiSel.size > 0 && !multiSel.has(`clip:${c.id}`)) setMultiSel(new Set());
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        clipDragRef.current = { mode, id: c.id, startX: e.clientX, origIn: c.inPoint, origOut: c.outPoint, moved: false };
        setSelected({ kind: 'clip', id: c.id });
    };

    const onClipPointerMove = (e: React.PointerEvent) => {
        const d = clipDragRef.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        if (Math.abs(dx) > 4) d.moved = true;
        const clip = clips.find(c => c.id === d.id);
        if (!clip) return;

        if (d.mode === 'move') {
            setClipDragOffset({ id: d.id, dx });
        } else if (d.mode === 'trimL') {
            // 拖左边缘：调入点（时间轴秒 → 素材秒要乘 speed）
            const dSec = (dx / pxPerSec) * clip.speed;
            const newIn = Math.min(Math.max(0, d.origIn + dSec), clip.outPoint - 0.2);
            updateClip(d.id, { inPoint: newIn });
        } else {
            // 拖右边缘：调出点
            const dSec = (dx / pxPerSec) * clip.speed;
            const newOut = Math.max(Math.min(clip.sourceDuration, d.origOut + dSec), clip.inPoint + 0.2);
            updateClip(d.id, { outPoint: newOut });
        }
    };

    const onClipPointerUp = () => {
        const d = clipDragRef.current;
        clipDragRef.current = null;
        if (!d) return;
        if (d.mode === 'move' && d.moved && clipDragOffset) {
            // 根据拖拽后中心点位置计算目标插入位
            const idx = clips.findIndex(c => c.id === d.id);
            if (idx >= 0) {
                const widths = clips.map(c => Math.max(clipDur(c) * pxPerSec, 30));
                const leftOf = (i: number) => widths.slice(0, i).reduce((s, w) => s + w, 0);
                const center = leftOf(idx) + clipDragOffset.dx + widths[idx] / 2;
                // 在去掉本片段后的布局里找插入位置
                let target = 0, acc = 0;
                for (let i = 0; i < clips.length; i++) {
                    if (i === idx) continue;
                    if (center > acc + widths[i] / 2) target++;
                    acc += widths[i];
                }
                if (target !== idx) {
                    setClips(prev => {
                        const next = [...prev];
                        const [moved] = next.splice(idx, 1);
                        next.splice(target, 0, moved);
                        return next;
                    });
                    currentClipIdxRef.current = -1;
                }
            }
        }
        setClipDragOffset(null);
    };

    // ---- 复制 / 剪切 / 粘贴 / 删除 + 右键菜单 ----
    type ItemKind = 'clip' | 'sub' | 'audio' | 'sticker' | 'overlay';
    const clipboardRef = useRef<{ kind: ItemKind; data: Clip | SubtitleItem | AudioItem | Sticker | OverlayClip } | null>(null);
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: { kind: ItemKind; id: string } | 'empty' } | null>(null);
    const [clipboardVersion, setClipboardVersion] = useState(0); // 刷新右键菜单"粘贴"可用态
    void clipboardVersion;

    const deleteItem = (kind: ItemKind, id: string) => {
        if (kind === 'clip') removeClip(id);
        else if (kind === 'sub') setSubtitles(p => p.filter(s => s.id !== id));
        else if (kind === 'sticker') setStickers(p => p.filter(s => s.id !== id));
        else if (kind === 'overlay') setOverlays(p => p.filter(o => o.id !== id));
        else setAudios(p => p.filter(a => a.id !== id));
        if (selected?.id === id) setSelected(null);
    };

    const copyItem = (kind: ItemKind, id: string) => {
        const src =
            kind === 'clip' ? clips.find(c => c.id === id) :
                kind === 'sub' ? subtitles.find(s => s.id === id) :
                    kind === 'sticker' ? stickers.find(s => s.id === id) :
                        kind === 'overlay' ? overlays.find(o => o.id === id) :
                            audios.find(a => a.id === id);
        if (!src) return;
        clipboardRef.current = { kind, data: structuredClone(src) };
        setClipboardVersion(v => v + 1);
    };

    /** 粘贴：片段插到选中片段之后（否则末尾）；其余对象粘贴到播放头处 */
    const pasteClipboard = () => {
        const cb = clipboardRef.current;
        if (!cb) return;
        const t = playheadRef.current;
        if (cb.kind === 'clip') {
            const copy: Clip = { ...(cb.data as Clip), id: uid() };
            setClips(prev => {
                const idx = selected?.kind === 'clip' ? prev.findIndex(c => c.id === selected.id) : prev.length - 1;
                const at = idx >= 0 ? idx + 1 : prev.length;
                const next = [...prev];
                next.splice(at, 0, copy);
                return next;
            });
            setTransitions(prev => [...prev, { type: 'none', duration: 0.5 }].slice(0, Math.max(0, clips.length)));
            setSelected({ kind: 'clip', id: copy.id });
            currentClipIdxRef.current = -1;
        } else if (cb.kind === 'sub') {
            const d = cb.data as SubtitleItem;
            const copy: SubtitleItem = { ...structuredClone(d), id: uid(), start: t, end: t + (d.end - d.start) };
            setSubtitles(prev => [...prev, copy].sort((a, b) => a.start - b.start));
            setSelected({ kind: 'sub', id: copy.id });
        } else if (cb.kind === 'sticker') {
            const d = cb.data as Sticker;
            const copy: Sticker = { ...structuredClone(d), id: uid(), start: t, end: t + (d.end - d.start) };
            setStickers(prev => [...prev, copy]);
            setSelected({ kind: 'sticker', id: copy.id });
        } else if (cb.kind === 'overlay') {
            const d = cb.data as OverlayClip;
            const copy: OverlayClip = { ...structuredClone(d), id: uid(), start: t };
            setOverlays(prev => [...prev, copy]);
            setSelected({ kind: 'overlay', id: copy.id });
        } else {
            const d = cb.data as AudioItem;
            const copy: AudioItem = { ...structuredClone(d), id: uid(), start: t };
            setAudios(prev => [...prev, copy]);
            setSelected({ kind: 'audio', id: copy.id });
        }
    };

    /** 右键打开菜单（条目或空白处） */
    const openCtxMenu = (e: React.MouseEvent, target: { kind: ItemKind; id: string } | 'empty') => {
        e.preventDefault();
        e.stopPropagation();
        if (target !== 'empty') setSelected(target);
        setCtxMenu({ x: e.clientX, y: e.clientY, target });
    };

    // ---- 键盘快捷键：Delete 删除选中、空格播放/暂停 ----
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                if (selected) { e.preventDefault(); copyItem(selected.kind, selected.id); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
                if (selected) {
                    e.preventDefault();
                    copyItem(selected.kind, selected.id);
                    deleteItem(selected.kind, selected.id);
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                if (clipboardRef.current) { e.preventDefault(); pasteClipboard(); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                selectAllTimeline();
                return;
            }
            if (e.key === 'Escape' && multiSel.size > 0) {
                setMultiSel(new Set());
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (multiSel.size > 0) { deleteMultiSelected(); return; }
                if (!selected) return;
                if (selected.kind === 'clip') removeClip(selected.id);
                else if (selected.kind === 'sub') { setSubtitles(p => p.filter(s => s.id !== selected.id)); setSelected(null); }
                else if (selected.kind === 'sticker') { setStickers(p => p.filter(s => s.id !== selected.id)); setSelected(null); }
                else { setAudios(p => p.filter(a => a.id !== selected.id)); setSelected(null); }
            } else if (e.key === ' ') {
                e.preventDefault();
                handlePlayPause();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // ---- 贴纸操作 ----
    const addSticker = (emoji: string) => {
        const s: Sticker = {
            id: uid(), emoji,
            x: 0.5, y: 0.35, size: 0.18,
            start: playheadRef.current,
            end: playheadRef.current + 3,
        };
        setStickers(prev => [...prev, s]);
        setSelected({ kind: 'sticker', id: s.id });
    };

    // 预览画面上拖拽贴纸
    const stickerDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

    const onStickerPointerDown = (e: React.PointerEvent, s: Sticker) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        stickerDragRef.current = { id: s.id, startX: e.clientX, startY: e.clientY, origX: s.x, origY: s.y };
        setSelected({ kind: 'sticker', id: s.id });
    };

    const onStickerPointerMove = (e: React.PointerEvent) => {
        const d = stickerDragRef.current;
        const wrap = videoWrapRef.current;
        if (!d || !wrap) return;
        const rect = wrap.getBoundingClientRect();
        const nx = Math.min(1, Math.max(0, d.origX + (e.clientX - d.startX) / rect.width));
        const ny = Math.min(1, Math.max(0, d.origY + (e.clientY - d.startY) / rect.height));
        setStickers(prev => prev.map(s => s.id === d.id ? { ...s, x: nx, y: ny } : s));
    };

    const onStickerPointerUp = () => { stickerDragRef.current = null; };

    // 预览画面上拖拽画中画（posX/posY 为 -1~1 的画面比例偏移）
    const overlayDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

    const onOverlayPointerDown = (e: React.PointerEvent, o: OverlayClip) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        overlayDragRef.current = { id: o.id, startX: e.clientX, startY: e.clientY, origX: o.posX, origY: o.posY };
        setSelected({ kind: 'overlay', id: o.id });
    };

    const onOverlayPointerMove = (e: React.PointerEvent) => {
        const d = overlayDragRef.current;
        const wrap = videoWrapRef.current;
        if (!d || !wrap) return;
        const rect = wrap.getBoundingClientRect();
        const nx = Math.min(1, Math.max(-1, d.origX + (e.clientX - d.startX) / rect.width));
        const ny = Math.min(1, Math.max(-1, d.origY + (e.clientY - d.startY) / rect.height));
        setOverlays(prev => prev.map(o => o.id === d.id ? { ...o, posX: nx, posY: ny } : o));
    };

    const onOverlayPointerUp = () => { overlayDragRef.current = null; };

    // ---- 预览画面上拖拽字幕（剪映式自由定位）----
    const previewDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

    const onPreviewSubPointerDown = (e: React.PointerEvent, sub: SubtitleItem) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        previewDragRef.current = { id: sub.id, startX: e.clientX, startY: e.clientY, origX: sub.style.x, origY: sub.style.y };
        setSelected({ kind: 'sub', id: sub.id });
    };

    const onPreviewSubPointerMove = (e: React.PointerEvent) => {
        const d = previewDragRef.current;
        const wrap = videoWrapRef.current;
        if (!d || !wrap) return;
        const rect = wrap.getBoundingClientRect();
        const nx = Math.min(1, Math.max(0, d.origX + (e.clientX - d.startX) / rect.width));
        const ny = Math.min(1, Math.max(0, d.origY + (e.clientY - d.startY) / rect.height));
        patchSubStyle(d.id, { x: nx, y: ny });
    };

    const onPreviewSubPointerUp = () => { previewDragRef.current = null; };

    // ============================================================================
    // 智能配音 + 字幕
    // ============================================================================

    const handleGenerateScript = async () => {
        setGeneratingScript(true);
        setErrorMsg(null);
        try {
            const clipTotal = clips.reduce((s, c) => s + (c.outPoint - c.inPoint), 0);
            const res = await fetch('/api/video-studio/script', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: scriptPrompt || clips.map(c => c.name).join('；') || '生成一段视频解说词',
                    durationHint: clipTotal > 0 ? Math.round(clipTotal) : undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '脚本生成失败');
            setScript(data.script);
        } catch (err: any) {
            setErrorMsg(err.message);
        } finally {
            setGeneratingScript(false);
        }
    };

    const handleGenerateVoiceAndSubs = async () => {
        const sentences = script.split(/[。！？!?\n]+/).map(s => s.trim()).filter(Boolean);
        if (sentences.length === 0) {
            setErrorMsg('请先输入或生成配音脚本');
            return;
        }
        setGeneratingTTS(true);
        setErrorMsg(null);
        try {
            let cursor = playheadRef.current;
            const newAudios: AudioItem[] = [];
            const newSubs: SubtitleItem[] = [];
            for (let i = 0; i < sentences.length; i++) {
                setTtsProgress(`正在合成 ${i + 1}/${sentences.length} 句…`);
                const res = await fetch('/api/video-studio/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: sentences[i], voice }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '语音合成失败');
                newAudios.push({ id: uid(), url: data.url, text: sentences[i], start: cursor, duration: data.duration, inPoint: 0, outPoint: data.duration, volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0, track: 0 });
                // 字幕显示去掉句尾标点（朗读文本保留标点以保证停顿语气）
                newSubs.push({ id: uid(), text: sentences[i].replace(/[，。！？、；：…,.!?;:\s]+$/u, '') || sentences[i], start: cursor, end: cursor + data.duration, style: { ...defaultStyle } });
                cursor += data.duration + 0.15;
            }
            setAudios(prev => [...prev, ...newAudios]);
            setSubtitles(prev => [...prev, ...newSubs].sort((a, b) => a.start - b.start));
        } catch (err: any) {
            setErrorMsg(err.message);
        } finally {
            setGeneratingTTS(false);
            setTtsProgress('');
        }
    };

    /** 智能字幕：识别视频原声或配音轨的语音，按时间自动生成字幕 */
    const handleSmartSubtitles = async (source: 'video' | 'audio') => {
        let segments: { url: string; inPoint: number; outPoint: number; start: number; speed: number }[];
        if (source === 'video') {
            segments = clips
                .map((c, i) => ({ c, i }))
                .filter(({ c }) => !c.isImage && !c.muted && c.volume > 0 && !c.reverse)
                .map(({ c, i }) => ({ url: c.url, inPoint: c.inPoint, outPoint: c.outPoint, start: clipStarts[i], speed: c.speed }));
            if (segments.length === 0) {
                setErrorMsg('时间轴上没有可识别的视频原声（图片/静音/倒放片段会被跳过）');
                return;
            }
        } else {
            segments = audios
                .filter(a => !a.muted && a.volume > 0)
                .map(a => ({ url: a.url, inPoint: a.inPoint, outPoint: a.outPoint, start: a.start, speed: a.speed }));
            if (segments.length === 0) {
                setErrorMsg('配音轨上没有可识别的音频');
                return;
            }
        }
        setTranscribing(true);
        setErrorMsg(null);
        try {
            // 单条字幕最大字数：按导出分辨率、字号与最大宽度估算一行能放下的字数（竖屏自动更短）
            const r = RESOLUTIONS.find(x => x.id === resolution) || RESOLUTIONS[0];
            const fontPx = Math.max(12, (defaultStyle.fontScale || 0.052) * r.h);
            // 上限 14 字：横屏分辨率下按宽度能放下 20+ 字，但阅读体验上单条不宜超过 14 字
            const maxLen = Math.max(6, Math.min(14, Math.floor((r.w * (defaultStyle.maxW ?? 0.9)) / fontPx)));
            const res = await fetch('/api/video-studio/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ segments, maxLen }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '语音识别失败');
            if (!Array.isArray(data.subtitles) || data.subtitles.length === 0) {
                setErrorMsg(data.message || '未识别到有效语音');
                return;
            }
            const newSubs: SubtitleItem[] = data.subtitles.map((s: { start: number; end: number; text: string }) => ({
                id: uid(),
                text: s.text,
                start: s.start,
                end: Math.max(s.end, s.start + 0.3),
                style: { ...defaultStyle },
            }));
            setSubtitles(prev => [...prev, ...newSubs].sort((a, b) => a.start - b.start));
        } catch (err: any) {
            setErrorMsg(err.message || '语音识别失败');
        } finally {
            setTranscribing(false);
        }
    };

    // ============================================================================
    // 导出
    // ============================================================================

    const handleExport = async () => {
        if (clips.length === 0) {
            setErrorMsg('请先把视频素材添加到时间轴');
            return;
        }
        setExporting(true);
        setExportUrl(null);
        setErrorMsg(null);
        try {
            const r = RESOLUTIONS.find(x => x.id === resolution) || RESOLUTIONS[0];
            const res = await fetch('/api/video-studio/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clips: clips.map(c => ({
                        url: c.url, inPoint: c.inPoint, outPoint: c.outPoint,
                        speed: c.speed, muted: c.muted, volume: c.volume, reverse: c.reverse,
                        rotate: c.rotate, flipH: c.flipH, flipV: c.flipV, eq: c.eq,
                        scale: c.scale, posX: c.posX, posY: c.posY, effect: c.effect,
                    })),
                    transitions,
                    subtitles: subtitles.map(s => ({ text: s.text, start: s.start, end: s.end, style: s.style })),
                    subtitleStyle: defaultStyle,
                    audios: audios.map(a => ({
                        url: a.url, start: a.start, volume: a.volume,
                        // 逐轨静音在客户端折算到条目级（服务端无需感知音轨）
                        muted: a.muted || !!audioLaneMuted[aTrack(a)],
                        speed: a.speed, fadeIn: a.fadeIn, fadeOut: a.fadeOut, duration: a.duration,
                        inPoint: a.inPoint, outPoint: a.outPoint,
                    })),
                    stickers: stickers.map(s => ({
                        data: renderEmojiToPng(s.emoji),
                        x: s.x, y: s.y, size: s.size, start: s.start, end: s.end,
                    })),
                    overlays: [...overlays].sort((a, b) => oTrack(a) - oTrack(b)).map(o => ({
                        url: o.url, start: o.start, inPoint: o.inPoint, outPoint: o.outPoint,
                        speed: o.speed, muted: o.muted || videoTrackMuted, volume: o.volume,
                        scale: o.scale, posX: o.posX, posY: o.posY, isImage: !!o.isImage,
                        mask: o.mask || 'none',
                    })),
                    videoTrackMuted,
                    audioTrackMuted,
                    width: r.w, height: r.h, fps: 30,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '导出失败');
            setExportUrl(data.url);
        } catch (err: any) {
            setErrorMsg(err.message);
        } finally {
            setExporting(false);
        }
    };

    // ============================================================================
    // 渲染
    // ============================================================================

    if (!isOpen) return null;

    const currentSub = subtitles.find(s => playhead >= s.start && playhead < s.end);
    const currentStickers = stickers.filter(s => playhead >= s.start && playhead < s.end);
    const curClipIdx = clips.length > 0 ? findClipAt(playhead).idx : -1;
    const curClip = curClipIdx >= 0 ? clips[curClipIdx] : null;
    const curFx = curClip?.effect ? FX_PRESETS.find(f => f.id === curClip.effect) : null;
    const selClip = selected?.kind === 'clip' ? clips.find(c => c.id === selected.id) : null;
    const selOverlay = selected?.kind === 'overlay' ? overlays.find(o => o.id === selected.id) : null;
    const patchOverlay = (id: string, patch: Partial<OverlayClip>) =>
        setOverlays(prev => prev.map(o => o.id === id ? { ...o, ...patch } : o));
    const selSticker = selected?.kind === 'sticker' ? stickers.find(s => s.id === selected.id) : null;
    const selSub = selected?.kind === 'sub' ? subtitles.find(s => s.id === selected.id) : null;
    const selAudio = selected?.kind === 'audio' ? audios.find(a => a.id === selected.id) : null;
    const timelineWidth = Math.max(600, (totalDuration + 5) * pxPerSec);

    // 自适应刻度间隔：保证相邻刻度至少间隔约 50px
    const tickInterval = (() => {
        for (const c of [1, 2, 5, 10, 15, 30, 60, 120, 300]) {
            if (c * pxPerSec >= 50) return c;
        }
        return 600;
    })();
    const tickCount = Math.ceil((totalDuration + 5) / tickInterval) + 1;
    const fmtTick = (t: number) => t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`;

    return (
        <div className="fixed inset-x-0 bottom-0 z-[200] bg-[#0b0b0b] text-white flex flex-col select-none" style={{ top: 'var(--titlebar-h, 0px)' }}>
            {/* 隐藏的配音 audio 元素 */}
            {audios.map(a => (
                <audio
                    key={a.id}
                    ref={el => { if (el) audioElsRef.current.set(a.id, el); else audioElsRef.current.delete(a.id); }}
                    src={a.url.startsWith('http') ? a.url : `${a.url}`}
                    preload="auto"
                />
            ))}

            {/* ===== 顶部栏 ===== */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-neutral-800 flex-shrink-0">
                <div className="flex items-center gap-3">
                    <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-neutral-800 flex items-center justify-center" title="关闭">
                        <X size={18} />
                    </button>
                    <Scissors size={18} className="text-cyan-400" />
                    <span className="font-semibold">视频剪辑</span>
                </div>
                <div className="flex items-center gap-3">
                    {errorMsg && <span className="text-xs text-red-400 max-w-[360px] truncate" title={errorMsg}>{errorMsg}</span>}
                    {exportUrl && (
                        <a
                            href={`${exportUrl}`}
                            download
                            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-green-600/20 text-green-400 border border-green-700 hover:bg-green-600/30"
                        >
                            <Download size={14} /> 下载成品（已存入历史）
                        </a>
                    )}
                    {/* 历史剪辑下拉：选择即打开对应剪辑项目 */}
                    <select
                        value={currentProjectId ?? ''}
                        onChange={e => handleOpenProject(e.target.value)}
                        disabled={openingProject}
                        className="bg-neutral-800 border border-neutral-700 rounded-lg px-2 py-2 text-xs outline-none max-w-[200px] disabled:opacity-50"
                        title="打开历史剪辑"
                    >
                        <option value="">{projects.length ? '历史剪辑…' : '暂无历史剪辑'}</option>
                        {projects.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.name}（{p.clipCount ?? 0} 段{p.updatedAt ? ` · ${new Date(p.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}）
                            </option>
                        ))}
                    </select>
                    {currentProjectId && (
                        <button
                            onClick={handleDeleteProject}
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-400 hover:text-red-400 hover:bg-neutral-800"
                            title="删除当前剪辑记录"
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                    {/* 保存当前剪辑状态 */}
                    <button
                        onClick={handleSaveProject}
                        disabled={savingProject || (clips.length === 0 && subtitles.length === 0 && audios.length === 0 && stickers.length === 0)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        title={currentProjectId ? `保存到「${currentProjectName}」` : '保存为新剪辑项目'}
                    >
                        {savingProject ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        {currentProjectId ? '保存剪辑' : '保存为新剪辑'}
                    </button>
                    <select
                        value={resolution}
                        onChange={e => setResolution(e.target.value)}
                        className="bg-neutral-800 border border-neutral-700 rounded-lg px-2 py-2 text-xs outline-none"
                    >
                        {RESOLUTIONS.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <button
                        onClick={handleExport}
                        disabled={exporting || clips.length === 0}
                        className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {exporting ? (<><Loader2 size={15} className="animate-spin" /> 合成中…</>) : '导出视频'}
                    </button>
                </div>
            </div>

            {/* ===== 主区域 ===== */}
            <div className="flex-1 flex min-h-0">
                {/* --- 左：素材库（支持拖放文件导入） --- */}
                <div
                    className={`relative w-60 border-r flex flex-col flex-shrink-0 min-h-0 transition-colors ${libDragOver ? 'border-cyan-500' : 'border-neutral-800'}`}
                    onDragOver={handleLibDragOver}
                    onDragLeave={handleLibDragLeave}
                    onDrop={handleLibDrop}
                >
                    {libDragOver && (
                        <div className="absolute inset-0 z-20 bg-cyan-500/10 border-2 border-dashed border-cyan-500 rounded-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
                            <Plus size={28} className="text-cyan-400" />
                            <span className="text-xs font-medium text-cyan-300">松开导入视频 / 图片</span>
                        </div>
                    )}
                    <div className="px-3 py-2 text-xs font-bold text-neutral-400 border-b border-neutral-800 flex items-center justify-between">
                        <span className="flex items-center gap-1.5"><Film size={13} /> 素材列表（{library.length}）</span>
                        <input ref={videoFileRef} type="file" multiple accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp" onChange={handleImportVideoFile} className="hidden" />
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => videoFileRef.current?.click()}
                                disabled={importingVideo}
                                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-50"
                                title="批量导入本地视频/图片到素材库（可多选文件）"
                            >
                                {importingVideo ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} 导入
                            </button>
                            <button
                                onClick={() => { setLibSelectMode(m => !m); setLibSelected(new Set()); }}
                                className={`text-[10px] px-2 py-1 rounded border ${libSelectMode ? 'bg-cyan-600/30 border-cyan-600 text-cyan-300' : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-300'}`}
                                title="进入/退出多选管理模式"
                            >
                                管理
                            </button>
                        </div>
                    </div>
                    {/* 类型筛选：全部 / 视频 / 图片 */}
                    <div className="px-2 py-1.5 border-b border-neutral-800 flex items-center gap-1">
                        {([
                            { key: 'all' as const, label: '全部', count: library.length },
                            { key: 'video' as const, label: '视频', count: library.filter(v => v.assetType === 'video').length },
                            { key: 'image' as const, label: '图片', count: library.filter(v => v.assetType === 'image').length },
                        ]).map(f => (
                            <button
                                key={f.key}
                                onClick={() => setLibFilter(f.key)}
                                className={`flex-1 text-[10px] px-1.5 py-1 rounded border transition-colors ${libFilter === f.key
                                    ? 'bg-cyan-600/30 border-cyan-600 text-cyan-300'
                                    : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-400'}`}
                            >
                                {f.label} {f.count}
                            </button>
                        ))}
                    </div>
                    {/* 多选模式工具栏 */}
                    {libSelectMode && (
                        <div className="px-2 py-1.5 border-b border-neutral-800 flex items-center gap-1 text-[10px]">
                            <button
                                onClick={() => setLibSelected(prev => prev.size === filteredLibrary.length ? new Set() : new Set(filteredLibrary.map(v => `${v.assetType}_${v.id}`)))}
                                className="px-1.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300"
                            >
                                {libSelected.size === filteredLibrary.length && filteredLibrary.length > 0 ? '取消全选' : '全选'}
                            </button>
                            <button
                                onClick={handleBatchDelete}
                                disabled={libSelected.size === 0 || libDeleting}
                                className="flex items-center gap-0.5 px-1.5 py-1 rounded bg-red-600/20 hover:bg-red-600/40 border border-red-800 text-red-300 disabled:opacity-40"
                            >
                                {libDeleting ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />} 删除({libSelected.size})
                            </button>
                            <button
                                onClick={handleClearLibrary}
                                disabled={library.length === 0 || libDeleting}
                                className="px-1.5 py-1 rounded bg-red-600/20 hover:bg-red-600/40 border border-red-800 text-red-300 disabled:opacity-40"
                            >
                                清空
                            </button>
                            <div className="flex-1" />
                            <button
                                onClick={() => { setLibSelectMode(false); setLibSelected(new Set()); }}
                                className="px-1.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300"
                            >
                                完成
                            </button>
                        </div>
                    )}
                    <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-wrap gap-2 content-start">
                        {libLoading && <div className="w-full flex justify-center py-6"><Loader2 className="animate-spin text-neutral-500" size={18} /></div>}
                        {!libLoading && filteredLibrary.length === 0 && (
                            <div className="w-full text-center text-xs text-neutral-600 py-8">
                                {library.length === 0 ? <>还没有素材<br />去画布生成、点上方「导入」<br />或直接把文件拖到这里</> : '该分类下没有素材'}
                            </div>
                        )}
                        {filteredLibrary.map(v => {
                            const checked = libSelected.has(`${v.assetType}_${v.id}`);
                            return (
                            <div
                                key={`${v.assetType}_${v.id}`}
                                className={`group relative w-[calc(50%-4px)] flex-shrink-0 rounded-lg overflow-hidden bg-neutral-900 border cursor-pointer ${libSelectMode && checked ? 'border-cyan-500 ring-1 ring-cyan-500/60' : 'border-neutral-800 hover:border-cyan-600'}`}
                                onClick={() => libSelectMode ? toggleLibSelect(v) : addClipFromLibrary(v)}
                                draggable={!libSelectMode}
                                onDragStart={e => {
                                    e.dataTransfer.setData('application/x-library-asset', JSON.stringify(v));
                                    e.dataTransfer.effectAllowed = 'copy';
                                }}
                                title={[v.title, v.prompt].filter(Boolean).join('\n')}
                            >
                                {v.assetType === 'image' ? (
                                    <img
                                        src={v.url.startsWith('http') ? v.url : `${v.url}`}
                                        loading="lazy"
                                        className="w-full h-14 object-cover pointer-events-none"
                                    />
                                ) : (
                                    <video
                                        src={(v.url.startsWith('http') ? v.url : `${v.url}`) + '#t=0.5'}
                                        preload="metadata"
                                        muted
                                        className="w-full h-14 object-cover pointer-events-none"
                                    />
                                )}
                                <span className={`absolute top-1 left-1 text-[8px] px-1 rounded ${v.assetType === 'image' ? 'bg-emerald-700/80 text-emerald-100' : 'bg-sky-700/80 text-sky-100'}`}>
                                    {v.assetType === 'image' ? '图片' : '视频'}
                                </span>
                                {!libSelectMode && (
                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                                        <Plus size={20} className="text-white" />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); addOverlayFromLibrary(v); }}
                                            className="absolute bottom-0.5 right-1 px-1.5 py-0.5 rounded text-[9px] bg-amber-600/80 hover:bg-amber-500 text-white"
                                            title="添加为画中画（播放头处）"
                                        >
                                            ⧉ 画中画
                                        </button>
                                    </div>
                                )}
                                {/* 多选模式：勾选框；普通模式：悬停删除按钮 */}
                                {libSelectMode ? (
                                    <span className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center border ${checked ? 'bg-cyan-500 border-cyan-300 text-white' : 'bg-black/60 border-neutral-500 text-transparent'}`}>
                                        <Check size={12} />
                                    </span>
                                ) : (
                                    <button
                                        onClick={(e) => deleteLibraryAsset(e, v)}
                                        className="absolute top-1 right-1 w-5 h-5 rounded bg-black/70 text-neutral-300 hover:bg-red-600 hover:text-white items-center justify-center hidden group-hover:flex"
                                        title="从素材库删除"
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                )}
                                <div className="px-1.5 py-1 text-[10px] truncate">
                                    {v.title ? (
                                        <span className="text-cyan-300 font-medium">{v.title}</span>
                                    ) : (
                                        <span className="text-neutral-400">{v.prompt || '视频'}</span>
                                    )}
                                </div>
                            </div>
                            );
                        })}
                        {/* 一键添加：当前筛选的素材按镜头顺序全部加入时间轴 */}
                        {!libLoading && !libSelectMode && filteredLibrary.length > 0 && (
                            <button
                                onClick={handleAddAllToTimeline}
                                disabled={addingAll}
                                className="w-full mt-1 py-2 rounded-lg border border-dashed border-neutral-700 text-[11px] text-neutral-400 hover:text-cyan-300 hover:border-cyan-600 hover:bg-cyan-500/5 flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                                title="按列表顺序（镜头编号升序）把当前筛选的素材全部添加到时间轴"
                            >
                                {addingAll ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                                一键添加{libFilter === 'video' ? '全部视频' : libFilter === 'image' ? '全部图片' : '全部素材'}（{filteredLibrary.length}）
                            </button>
                        )}
                    </div>
                </div>

                {/* --- 中：预览 --- */}
                <div ref={previewColRef} className="flex-1 flex flex-col min-w-0 bg-[#0a0a0b]">
                    <div
                        ref={previewAreaRef}
                        className="flex-1 flex items-center justify-center bg-black relative min-h-0 overflow-hidden"
                        onDoubleClick={() => { if (clips.length > 0) toggleFullscreen(); }}
                        title="双击切换全屏播放"
                    >
                        {clips.length === 0 ? (
                            <div className="text-neutral-600 text-sm">从左侧素材库点击视频添加到时间轴</div>
                        ) : (
                            <div ref={videoWrapRef} className="relative">
                                <video
                                    ref={videoRef}
                                    className="block"
                                    playsInline
                                    style={{
                                        // 像素级约束 + 适当留白（预览不要顶满）
                                        maxWidth: previewSize.w > 0 ? Math.round(previewSize.w * (isFullscreen ? 0.98 : 0.82)) : '100%',
                                        maxHeight: previewSize.h > 0 ? Math.round(previewSize.h * (isFullscreen ? 0.97 : 0.92)) : '100%',
                                        display: curClip?.isImage ? 'none' : 'block',
                                        ...(curClip && !curClip.isImage ? {
                                            filter: `brightness(${(1 + curClip.eq.brightness).toFixed(2)}) contrast(${curClip.eq.contrast.toFixed(2)}) saturate(${curClip.eq.saturation.toFixed(2)})${curFx?.css ? ' ' + curFx.css : ''}`,
                                            transform: `translate(${(curClip.posX * 100).toFixed(1)}%, ${(curClip.posY * 100).toFixed(1)}%) rotate(${curClip.rotate}deg) scaleX(${curClip.flipH ? -curClip.scale : curClip.scale}) scaleY(${curClip.flipV ? -curClip.scale : curClip.scale})`,
                                        } : {}),
                                    }}
                                />
                                {/* 图片片段预览 */}
                                {curClip?.isImage && (
                                    <img
                                        ref={imgPreviewRef}
                                        src={curClip.url.startsWith('http') ? curClip.url : `${curClip.url}`}
                                        className="block"
                                        style={{
                                            maxWidth: previewSize.w > 0 ? Math.round(previewSize.w * (isFullscreen ? 0.98 : 0.82)) : '100%',
                                            maxHeight: previewSize.h > 0 ? Math.round(previewSize.h * (isFullscreen ? 0.97 : 0.92)) : '100%',
                                            filter: `brightness(${(1 + curClip.eq.brightness).toFixed(2)}) contrast(${curClip.eq.contrast.toFixed(2)}) saturate(${curClip.eq.saturation.toFixed(2)})${curFx?.css ? ' ' + curFx.css : ''}`,
                                            transform: `translate(${(curClip.posX * 100).toFixed(1)}%, ${(curClip.posY * 100).toFixed(1)}%) rotate(${curClip.rotate}deg) scaleX(${curClip.flipH ? -curClip.scale : curClip.scale}) scaleY(${curClip.flipV ? -curClip.scale : curClip.scale})`,
                                        }}
                                    />
                                )}
                                {/* 转场预览：上一片段最后一帧的退场动画（始终挂载，转场时显示） */}
                                <canvas
                                    ref={ghostCanvasRef}
                                    className="absolute inset-0 w-full h-full pointer-events-none"
                                    style={(() => {
                                        if (!transPreview) return { display: 'none' };
                                        const extra = ghostTransStyle(transPreview.type, transPreview.p);
                                        return {
                                            display: 'block',
                                            objectFit: 'contain' as const,
                                            opacity: extra.opacity,
                                            clipPath: extra.clipPath,
                                            filter: [transPreview.baseFilter, extra.filter].filter(Boolean).join(' ') || undefined,
                                            transform: [transPreview.baseTransform, extra.transform].filter(Boolean).join(' ') || undefined,
                                        };
                                    })()}
                                />
                                {/* 暗角特效预览层 */}
                                {curFx?.dark && (
                                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%)' }} />
                                )}
                                {/* 画中画叠加（视频元素常驻保持缓冲，按时间段显示；可拖拽调位置） */}
                                {[...overlays].sort((a, b) => oTrack(a) - oTrack(b)).map(o => {
                                    const inRange = playhead >= o.start && playhead < o.start + clipDur(o);
                                    const isSel = selected?.kind === 'overlay' && selected.id === o.id;
                                    return (
                                        <div
                                            key={o.id}
                                            onPointerDown={e => { if (inRange) onOverlayPointerDown(e, o); }}
                                            onPointerMove={onOverlayPointerMove}
                                            onPointerUp={onOverlayPointerUp}
                                            className="absolute cursor-grab active:cursor-grabbing"
                                            style={{
                                                left: `${(0.5 + o.posX) * 100}%`,
                                                top: `${(0.5 + o.posY) * 100}%`,
                                                transform: 'translate(-50%, -50%)',
                                                width: `${Math.min(1.5, Math.max(0.1, o.scale)) * 100}%`,
                                                display: inRange ? 'block' : 'none',
                                                zIndex: 5 + oTrack(o),
                                                // 选中时用虚线外框提示（仅编辑指示，不属于画面内容；播放中隐藏）
                                                outline: isSel && !playing ? '1px dashed rgba(34,211,238,0.75)' : 'none',
                                                outlineOffset: 3,
                                            }}
                                            title={`画中画：${o.name}（拖拽调整位置）`}
                                        >
                                            <div className="w-full" style={maskClipStyle(o.mask)}>
                                                {o.isImage ? (
                                                    <img
                                                        src={o.url.startsWith('http') ? o.url : `${o.url}`}
                                                        className="block w-full pointer-events-none"
                                                        draggable={false}
                                                    />
                                                ) : (
                                                    <video
                                                        ref={el => { if (el) overlayElsRef.current.set(o.id, el); else overlayElsRef.current.delete(o.id); }}
                                                        src={o.url.startsWith('http') ? o.url : `${o.url}`}
                                                        className="block w-full pointer-events-none"
                                                        playsInline
                                                        preload="auto"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* 贴纸叠加（可拖拽） */}
                                {currentStickers.map(s => (
                                    <span
                                        key={s.id}
                                        onPointerDown={e => onStickerPointerDown(e, s)}
                                        onPointerMove={onStickerPointerMove}
                                        onPointerUp={onStickerPointerUp}
                                        className={`absolute cursor-grab active:cursor-grabbing leading-none select-none ${selected?.kind === 'sticker' && selected.id === s.id ? 'ring-1 ring-cyan-400/80 rounded' : ''}`}
                                        style={{
                                            left: `${s.x * 100}%`,
                                            top: `${s.y * 100}%`,
                                            transform: `translate(-${s.x * 100}%, -${s.y * 100}%)`,
                                            fontSize: Math.max(16, s.size * videoBoxH),
                                        }}
                                        title="拖拽调整贴纸位置"
                                    >
                                        {s.emoji}
                                    </span>
                                ))}
                                {/* 字幕叠加：按 x/y 比例自由定位，可直接拖拽（剪映式） */}
                                {currentSub && (
                                    <span
                                        onPointerDown={e => onPreviewSubPointerDown(e, currentSub)}
                                        onPointerMove={onPreviewSubPointerMove}
                                        onPointerUp={onPreviewSubPointerUp}
                                        className={`absolute cursor-grab active:cursor-grabbing ${selected?.kind === 'sub' && selected.id === currentSub.id ? 'ring-1 ring-cyan-400/80 rounded' : ''}`}
                                        style={{
                                            left: `${currentSub.style.x * 100}%`,
                                            top: `${currentSub.style.y * 100}%`,
                                            transform: `translate(-${currentSub.style.x * 100}%, -${currentSub.style.y * 100}%)`,
                                            // width: max-content：绝对定位元素默认被容器右边界挤压收缩，
                                            // 拖到偏右时会被压成一字一行；按内容定宽后再用 maxWidth 控制换行
                                            width: 'max-content',
                                            maxWidth: Math.round((currentSub.style.maxW ?? 0.9) * videoBoxW),
                                        }}
                                        title="拖拽调整字幕位置"
                                    >
                                        {/* 内层负责视觉与入场动画（外层 transform 用于锚定定位，不能被动画覆盖） */}
                                        <span
                                            key={`${currentSub.id}_${currentSub.start}`}
                                            className="block font-semibold px-2 py-0.5 rounded text-center"
                                            style={{
                                                fontSize: Math.max(10, currentSub.style.fontScale * videoBoxH),
                                                color: currentSub.style.color,
                                                textShadow: `0 0 3px ${currentSub.style.outlineColor}, 1.5px 1.5px 1.5px ${currentSub.style.outlineColor}, -1px -1px 1.5px ${currentSub.style.outlineColor}`,
                                                backgroundColor: currentSub.style.background
                                                    ? currentSub.style.backgroundColor + Math.round(Math.min(1, Math.max(0, currentSub.style.bgOpacity ?? 0.85)) * 255).toString(16).padStart(2, '0')
                                                    : 'transparent',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-all',
                                                animation: currentSub.style.anim === 'fade' ? 'subFadeIn 0.3s ease-out'
                                                    : currentSub.style.anim === 'slideup' ? 'subSlideUp 0.35s ease-out'
                                                    : currentSub.style.anim === 'pop' ? 'subPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
                                                    : undefined,
                                            }}
                                        >
                                            {currentSub.text}
                                        </span>
                                    </span>
                                )}
                                <style>{`
                                    @keyframes subFadeIn { from { opacity: 0 } to { opacity: 1 } }
                                    @keyframes subSlideUp { from { opacity: 0; transform: translateY(0.6em) } to { opacity: 1; transform: none } }
                                    @keyframes subPop { 0% { opacity: 0; transform: scale(0.5) } 100% { opacity: 1; transform: scale(1) } }
                                `}</style>
                            </div>
                        )}
                    </div>
                    {/* 播放控制条 */}
                    <div className="h-12 flex items-center gap-3 px-4 border-t border-neutral-800 flex-shrink-0">
                        <button onClick={handlePlayPause} className="w-9 h-9 rounded-full bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center" title={playing ? '暂停' : '播放'}>
                            {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                        </button>
                        <span className="text-xs text-neutral-400 font-mono">{fmtTime(playhead)} / {fmtTime(totalDuration)}</span>
                        {/* 撤销 / 重做 */}
                        <button
                            onClick={undo}
                            disabled={!canUndo}
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="撤销 (Ctrl+Z)"
                        >
                            <Undo2 size={14} />
                        </button>
                        <button
                            onClick={redo}
                            disabled={!canRedo}
                            className="w-8 h-8 rounded-lg flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="重做 (Ctrl+Y)"
                        >
                            <Redo2 size={14} />
                        </button>
                        <button
                            onClick={splitAtPlayhead}
                            disabled={clips.length === 0}
                            className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-40"
                            title="在播放头处分割片段"
                        >
                            <Scissors size={12} /> 分割
                        </button>
                        <input ref={musicFileRef} type="file" accept="audio/*" onChange={handleImportMusicFile} className="hidden" />
                        <button
                            onClick={() => musicFileRef.current?.click()}
                            disabled={importingMusic}
                            className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-50"
                            title="导入本地音乐到配音轨（从播放头处）"
                        >
                            {importingMusic ? <Loader2 size={12} className="animate-spin" /> : '🎵'} 导入音乐
                        </button>
                        <div className="flex-1" />
                        <button
                            onClick={toggleFullscreen}
                            disabled={clips.length === 0}
                            className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 disabled:opacity-40"
                            title={isFullscreen ? '退出全屏 (Esc)' : '最大化播放预览'}
                        >
                            {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                            {isFullscreen ? '退出全屏' : '最大化'}
                        </button>
                        {!isFullscreen && <>
                            <span className="text-[10px] text-neutral-500" title="也可以在时间轴上直接滚动鼠标滚轮缩放">缩放（滚轮可缩放）</span>
                            <input type="range" min={2} max={200} value={pxPerSec} onChange={e => setPxPerSec(Number(e.target.value))} className="w-28" />
                        </>}
                    </div>
                </div>

                {/* --- 右：属性面板（视频 / 文字 / 声音 Tab）--- */}
                <div className="w-72 border-l border-neutral-800 flex flex-col flex-shrink-0">
                    {/* Tab 头 */}
                    <div className="flex border-b border-neutral-800 flex-shrink-0">
                        {([['video', '视频'], ['text', '文字'], ['audio', '声音'], ['sticker', '贴纸'], ['fx', '特效'], ['trans', '转场']] as const).map(([tab, label]) => (
                            <button
                                key={tab}
                                onClick={() => setPanelTab(tab)}
                                className={`flex-1 py-2.5 text-[11px] font-medium transition-colors ${panelTab === tab ? 'text-white border-b-2 border-cyan-400 bg-neutral-900/60' : 'text-neutral-500 hover:text-neutral-300'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="flex-1 overflow-y-auto">
                    {/* ===== 视频 Tab ===== */}
                    {panelTab === 'video' && !selClip && !selOverlay && (
                        <div className="p-4 text-xs text-neutral-600 text-center leading-5">
                            选中时间轴上的视频片段后<br />可编辑：裁剪 / 变速 / 音量 / 旋转翻转<br />缩放位置 / 画面调节 / 倒放等
                        </div>
                    )}
                    {/* ===== 画中画属性 ===== */}
                    {panelTab === 'video' && selOverlay && (
                        <div className="p-3 border-b border-neutral-800 space-y-2.5">
                            <div className="text-xs font-bold text-amber-300 flex items-center justify-between">
                                <span>⧉ 画中画属性</span>
                                <button onClick={() => deleteItem('overlay', selOverlay.id)} className="text-red-400 hover:text-red-300" title="删除画中画"><Trash2 size={14} /></button>
                            </div>
                            <div className="text-[11px] text-neutral-500 truncate">{selOverlay.name}</div>
                            <label className="block text-[11px] text-neutral-400">
                                开始时间（秒）
                                <input type="number" min={0} step={0.1} value={selOverlay.start.toFixed(1)}
                                    onChange={e => patchOverlay(selOverlay.id, { start: Math.max(0, Number(e.target.value)) })}
                                    className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-amber-500" />
                            </label>
                            <label className="block text-[11px] text-neutral-400">
                                画面大小 {(Math.min(1.5, Math.max(0.1, selOverlay.scale)) * 100).toFixed(0)}%（占画面宽度）
                                <input type="range" min={0.1} max={1.5} step={0.02} value={selOverlay.scale}
                                    onChange={e => patchOverlay(selOverlay.id, { scale: Number(e.target.value) })}
                                    className="mt-1 w-full" />
                            </label>
                            <div className="flex gap-2">
                                <label className="flex-1 text-[11px] text-neutral-400">
                                    水平位置
                                    <input type="range" min={-0.6} max={0.6} step={0.01} value={selOverlay.posX}
                                        onChange={e => patchOverlay(selOverlay.id, { posX: Number(e.target.value) })}
                                        className="mt-1 w-full" />
                                </label>
                                <label className="flex-1 text-[11px] text-neutral-400">
                                    垂直位置
                                    <input type="range" min={-0.6} max={0.6} step={0.01} value={selOverlay.posY}
                                        onChange={e => patchOverlay(selOverlay.id, { posY: Number(e.target.value) })}
                                        className="mt-1 w-full" />
                                </label>
                            </div>
                            <div className="text-[10px] text-neutral-600">在预览画面上可直接拖拽画中画调整位置</div>
                            <label className="block text-[11px] text-neutral-400">
                                蒙版
                                <div className="flex gap-1 mt-1">
                                    {OVERLAY_MASKS.map(m => (
                                        <button
                                            key={m.id}
                                            onClick={() => patchOverlay(selOverlay.id, { mask: m.id })}
                                            className={`flex-1 text-[10px] py-1 rounded border ${(selOverlay.mask || 'none') === m.id ? 'bg-amber-600/40 border-amber-500 text-amber-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}
                                        >
                                            {m.name}
                                        </button>
                                    ))}
                                </div>
                            </label>
                            {!selOverlay.isImage && (
                                <>
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => patchOverlay(selOverlay.id, { muted: !selOverlay.muted })}
                                            className={`text-[11px] px-2 py-1.5 rounded border ${selOverlay.muted ? 'bg-red-600/30 border-red-600 text-red-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}>
                                            {selOverlay.muted ? '🔇 已静音' : '🔊 原声'}
                                        </button>
                                        <input type="range" min={0} max={2} step={0.05} value={selOverlay.volume} disabled={selOverlay.muted}
                                            onChange={e => patchOverlay(selOverlay.id, { volume: Number(e.target.value) })}
                                            className="flex-1 disabled:opacity-40" />
                                        <span className="text-[10px] text-neutral-500 w-9 text-right">{Math.round(selOverlay.volume * 100)}%</span>
                                    </div>
                                    <label className="block text-[11px] text-neutral-400">
                                        倍速 {selOverlay.speed.toFixed(2)}x（变速后 {clipDur(selOverlay).toFixed(1)}s）
                                        <div className="flex gap-1 mt-1">
                                            {[0.5, 1, 1.5, 2].map(sp => (
                                                <button key={sp} onClick={() => patchOverlay(selOverlay.id, { speed: sp })}
                                                    className={`flex-1 text-[10px] py-0.5 rounded border ${selOverlay.speed === sp ? 'bg-amber-600/40 border-amber-500 text-amber-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}>
                                                    {sp}x
                                                </button>
                                            ))}
                                        </div>
                                    </label>
                                </>
                            )}
                            <div className="flex gap-1">
                                {Array.from({ length: overlayLanes }).map((_, L) => (
                                    <button
                                        key={L}
                                        onClick={() => patchOverlay(selOverlay.id, { track: L })}
                                        className={`flex-1 text-[10px] py-1 rounded border ${oTrack(selOverlay) === L ? 'bg-amber-600/40 border-amber-500 text-amber-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}
                                    >
                                        画中画轨{L + 1}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {panelTab === 'video' && selClip && (
                        <div className="p-3 border-b border-neutral-800 space-y-2.5">
                            <div className="text-xs font-bold text-neutral-300 flex items-center justify-between">
                                <span>片段属性</span>
                                <button onClick={() => removeClip(selClip.id)} className="text-red-400 hover:text-red-300" title="删除片段"><Trash2 size={14} /></button>
                            </div>
                            <div className="text-[11px] text-neutral-500 truncate">{selClip.name}</div>
                            <label className="block text-[11px] text-neutral-400">
                                入点（秒）
                                <input type="number" min={0} max={selClip.outPoint - 0.2} step={0.1} value={selClip.inPoint.toFixed(1)}
                                    onChange={e => updateClip(selClip.id, { inPoint: Math.max(0, Math.min(Number(e.target.value), selClip.outPoint - 0.2)) })}
                                    className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" />
                            </label>
                            <label className="block text-[11px] text-neutral-400">
                                {selClip.isImage ? '出点（秒，图片可自由设置显示时长）' : `出点（秒，素材总长 ${selClip.sourceDuration.toFixed(1)}s）`}
                                <input type="number" min={selClip.inPoint + 0.2} max={selClip.sourceDuration} step={0.1} value={selClip.outPoint.toFixed(1)}
                                    onChange={e => updateClip(selClip.id, { outPoint: Math.min(selClip.sourceDuration, Math.max(Number(e.target.value), selClip.inPoint + 0.2)) })}
                                    className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500" />
                            </label>
                            <div className="flex gap-2">
                                <button onClick={() => moveClip(selClip.id, -1)} className="flex-1 text-[11px] py-1.5 rounded bg-neutral-800 hover:bg-neutral-700">← 前移</button>
                                <button onClick={() => moveClip(selClip.id, 1)} className="flex-1 text-[11px] py-1.5 rounded bg-neutral-800 hover:bg-neutral-700">后移 →</button>
                                <button onClick={() => duplicateClip(selClip.id)} className="flex-1 text-[11px] py-1.5 rounded bg-neutral-800 hover:bg-neutral-700" title="复制此片段">复制</button>
                            </div>

                            {/* 变速（剪映「变速」）：拖动条 + 数字输入 */}
                            <label className="block text-[11px] text-neutral-400">
                                倍速 {selClip.speed.toFixed(2)}x（变速后 {clipDur(selClip).toFixed(1)}s）
                                <div className="flex items-center gap-2 mt-1">
                                    <input type="range" min={0.25} max={4} step={0.05} value={selClip.speed}
                                        onChange={e => updateClip(selClip.id, { speed: Number(e.target.value) })} className="flex-1" />
                                    <input type="number" min={0.25} max={4} step={0.05} value={selClip.speed}
                                        onChange={e => {
                                            const v = Number(e.target.value);
                                            if (!isNaN(v)) updateClip(selClip.id, { speed: Math.min(4, Math.max(0.25, v)) });
                                        }}
                                        className="w-16 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-1 text-xs outline-none focus:border-cyan-500" />
                                </div>
                                <div className="flex gap-1 mt-1">
                                    {[0.5, 1, 1.5, 2].map(sp => (
                                        <button key={sp} onClick={() => updateClip(selClip.id, { speed: sp })}
                                            className={`flex-1 text-[10px] py-0.5 rounded border ${selClip.speed === sp ? 'bg-cyan-600/40 border-cyan-500 text-cyan-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}>
                                            {sp}x
                                        </button>
                                    ))}
                                </div>
                            </label>

                            {/* 原声音量 / 静音 */}
                            <div className="flex items-center gap-2">
                                <button onClick={() => updateClip(selClip.id, { muted: !selClip.muted })}
                                    className={`text-[11px] px-2 py-1.5 rounded border ${selClip.muted ? 'bg-red-600/30 border-red-600 text-red-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}
                                    title="切换本片段原声静音">
                                    {selClip.muted ? '🔇 已静音' : '🔊 原声'}
                                </button>
                                <input type="range" min={0} max={2} step={0.05} value={selClip.volume} disabled={selClip.muted}
                                    onChange={e => updateClip(selClip.id, { volume: Number(e.target.value) })} className="flex-1 disabled:opacity-40" />
                                <span className="text-[10px] text-neutral-500 w-9 text-right">{Math.round(selClip.volume * 100)}%</span>
                            </div>

                            {/* 旋转 / 翻转 / 倒放 */}
                            <div className="flex gap-1.5">
                                <button onClick={() => updateClip(selClip.id, { rotate: ((selClip.rotate + 90) % 360) as 0 | 90 | 180 | 270 })}
                                    className="flex-1 text-[10px] py-1.5 rounded border bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500" title="顺时针旋转 90°">
                                    ⟳ {selClip.rotate}°
                                </button>
                                <button onClick={() => updateClip(selClip.id, { flipH: !selClip.flipH })}
                                    className={`flex-1 text-[10px] py-1.5 rounded border ${selClip.flipH ? 'bg-cyan-600/30 border-cyan-600 text-cyan-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}>
                                    水平翻转
                                </button>
                                <button onClick={() => updateClip(selClip.id, { flipV: !selClip.flipV })}
                                    className={`flex-1 text-[10px] py-1.5 rounded border ${selClip.flipV ? 'bg-cyan-600/30 border-cyan-600 text-cyan-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}>
                                    垂直翻转
                                </button>
                                <button onClick={() => updateClip(selClip.id, { reverse: !selClip.reverse })}
                                    className={`flex-1 text-[10px] py-1.5 rounded border ${selClip.reverse ? 'bg-orange-600/30 border-orange-600 text-orange-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}
                                    title="倒放（预览不生效，导出生效）">
                                    倒放
                                </button>
                            </div>

                            {/* 缩放与位置（剪映「位置大小」） */}
                            <div className="text-[11px] text-neutral-400 flex items-center justify-between">
                                缩放与位置
                                <button onClick={() => updateClip(selClip.id, { scale: 1, posX: 0, posY: 0 })} className="text-[10px] text-neutral-500 hover:text-neutral-300">重置</button>
                            </div>
                            <label className="block text-[10px] text-neutral-500">缩放 {Math.round(selClip.scale * 100)}%
                                <input type="range" min={0.2} max={3} step={0.05} value={selClip.scale}
                                    onChange={e => updateClip(selClip.id, { scale: Number(e.target.value) })} className="w-full" />
                            </label>
                            <label className="block text-[10px] text-neutral-500">水平位置 {Math.round(selClip.posX * 100)}
                                <input type="range" min={-1} max={1} step={0.02} value={selClip.posX}
                                    onChange={e => updateClip(selClip.id, { posX: Number(e.target.value) })} className="w-full" />
                            </label>
                            <label className="block text-[10px] text-neutral-500">垂直位置 {Math.round(selClip.posY * 100)}
                                <input type="range" min={-1} max={1} step={0.02} value={selClip.posY}
                                    onChange={e => updateClip(selClip.id, { posY: Number(e.target.value) })} className="w-full" />
                            </label>

                            {/* 画面调节（剪映「调节」） */}
                            <div className="text-[11px] text-neutral-400 flex items-center justify-between">
                                画面调节
                                <button onClick={() => updateClip(selClip.id, { eq: { ...DEFAULT_EQ } })} className="text-[10px] text-neutral-500 hover:text-neutral-300">重置</button>
                            </div>
                            <label className="block text-[10px] text-neutral-500">亮度 {selClip.eq.brightness > 0 ? '+' : ''}{Math.round(selClip.eq.brightness * 100)}
                                <input type="range" min={-0.5} max={0.5} step={0.02} value={selClip.eq.brightness}
                                    onChange={e => updateClip(selClip.id, { eq: { ...selClip.eq, brightness: Number(e.target.value) } })} className="w-full" />
                            </label>
                            <label className="block text-[10px] text-neutral-500">对比度 {selClip.eq.contrast.toFixed(2)}
                                <input type="range" min={0.5} max={2} step={0.05} value={selClip.eq.contrast}
                                    onChange={e => updateClip(selClip.id, { eq: { ...selClip.eq, contrast: Number(e.target.value) } })} className="w-full" />
                            </label>
                            <label className="block text-[10px] text-neutral-500">饱和度 {selClip.eq.saturation.toFixed(2)}（0 = 黑白）
                                <input type="range" min={0} max={3} step={0.05} value={selClip.eq.saturation}
                                    onChange={e => updateClip(selClip.id, { eq: { ...selClip.eq, saturation: Number(e.target.value) } })} className="w-full" />
                            </label>
                        </div>
                    )}
                    {panelTab === 'text' && selSub && (
                        <div className="p-3 border-b border-neutral-800 space-y-2.5">
                            <div className="text-xs font-bold text-neutral-300 flex items-center justify-between">
                                <span>字幕属性</span>
                                <button onClick={() => { setSubtitles(p => p.filter(s => s.id !== selSub.id)); setSelected(null); }} className="text-red-400 hover:text-red-300" title="删除字幕"><Trash2 size={14} /></button>
                            </div>
                            <textarea value={selSub.text} onChange={e => setSubtitles(p => p.map(s => s.id === selSub.id ? { ...s, text: e.target.value } : s))}
                                rows={2} className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 resize-none" />
                            <div className="text-[10px] text-neutral-600 -mt-1">字幕不自动换行；需要换行时在此按回车手动分行</div>
                            <div className="flex gap-2">
                                <label className="flex-1 text-[11px] text-neutral-400">开始
                                    <input type="number" min={0} step={0.1} value={selSub.start.toFixed(1)}
                                        onChange={e => setSubtitles(p => p.map(s => s.id === selSub.id ? { ...s, start: Math.max(0, Number(e.target.value)) } : s))}
                                        className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                </label>
                                <label className="flex-1 text-[11px] text-neutral-400">结束
                                    <input type="number" min={selSub.start + 0.2} step={0.1} value={selSub.end.toFixed(1)}
                                        onChange={e => setSubtitles(p => p.map(s => s.id === selSub.id ? { ...s, end: Math.max(s.start + 0.2, Number(e.target.value)) } : s))}
                                        className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                </label>
                            </div>

                            {/* ---- 样式（逐条） ---- */}
                            <div className="text-[11px] font-bold text-neutral-400 pt-1">经典样式</div>
                            {/* 8 种预设样式 */}
                            <div className="grid grid-cols-4 gap-1.5">
                                {SUB_PRESETS.map(p => (
                                    <button key={p.name} onClick={() => patchSubStyle(selSub.id, p.patch)}
                                        className="h-10 rounded-lg border border-neutral-700 hover:border-cyan-500 bg-[#161616] flex items-center justify-center text-xs font-bold transition-colors"
                                        title={p.name}>
                                        <span className="px-1 py-0.5 rounded" style={p.chipStyle}>{p.name}</span>
                                    </button>
                                ))}
                            </div>
                            <label className="block text-[11px] text-neutral-400">
                                字号 {(selSub.style.fontScale * 100).toFixed(1)}%（画面高度比例）
                                <div className="flex items-center gap-2 mt-1">
                                    <input type="range" min={0.02} max={0.15} step={0.002} value={selSub.style.fontScale}
                                        onChange={e => patchSubStyle(selSub.id, { fontScale: Number(e.target.value) })} className="flex-1" />
                                    <input type="number" min={2} max={15} step={0.2} value={(selSub.style.fontScale * 100).toFixed(1)}
                                        onChange={e => patchSubStyle(selSub.id, { fontScale: Math.min(0.15, Math.max(0.02, Number(e.target.value) / 100)) })}
                                        className="w-14 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-1 text-xs outline-none" />
                                </div>
                            </label>
                            <label className="block text-[11px] text-neutral-400">
                                最大宽度 {Math.round((selSub.style.maxW ?? 0.9) * 100)}%（画面宽度比例，超出自动换行）
                                <input type="range" min={0.3} max={1} step={0.05} value={selSub.style.maxW ?? 0.9}
                                    onChange={e => patchSubStyle(selSub.id, { maxW: Number(e.target.value) })} className="mt-1 w-full" />
                            </label>
                            <div className="flex gap-3">
                                <label className="flex-1 text-[11px] text-neutral-400">字体颜色
                                    <input type="color" value={selSub.style.color}
                                        onChange={e => patchSubStyle(selSub.id, { color: e.target.value })}
                                        className="mt-1 w-full h-7 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                </label>
                                <label className="flex-1 text-[11px] text-neutral-400">描边颜色
                                    <input type="color" value={selSub.style.outlineColor}
                                        onChange={e => patchSubStyle(selSub.id, { outlineColor: e.target.value })}
                                        className="mt-1 w-full h-7 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                </label>
                            </div>
                            <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer">
                                    <input type="checkbox" checked={selSub.style.background}
                                        onChange={e => patchSubStyle(selSub.id, { background: e.target.checked })} className="accent-yellow-500" />
                                    背景气泡
                                </label>
                                {selSub.style.background && (
                                    <input type="color" value={selSub.style.backgroundColor}
                                        onChange={e => patchSubStyle(selSub.id, { backgroundColor: e.target.value })}
                                        className="flex-1 h-6 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                )}
                            </div>
                            {selSub.style.background && (
                                <label className="block text-[11px] text-neutral-400">
                                    气泡不透明度 {Math.round((selSub.style.bgOpacity ?? 0.85) * 100)}%
                                    <input type="range" min={0.1} max={1} step={0.05} value={selSub.style.bgOpacity ?? 0.85}
                                        onChange={e => patchSubStyle(selSub.id, { bgOpacity: Number(e.target.value) })} className="mt-1 w-full" />
                                </label>
                            )}
                            <div className="text-[11px] text-neutral-400">入场动画</div>
                            <div className="flex gap-1.5">
                                {SUB_ANIMS.map(a => (
                                    <button key={a.id} onClick={() => patchSubStyle(selSub.id, { anim: a.id })}
                                        className={`flex-1 text-[10px] py-1.5 rounded border ${(selSub.style.anim ?? 'none') === a.id ? 'bg-yellow-600/30 border-yellow-600 text-yellow-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500'}`}>
                                        {a.name}
                                    </button>
                                ))}
                            </div>
                            {/* 位置：预览可直接拖拽，这里给快捷位 + 微调 */}
                            <div className="text-[11px] text-neutral-400">位置（可直接在预览画面拖拽字幕）</div>
                            <div className="flex gap-1.5">
                                {([['顶部', 0.5, 0.08], ['居中', 0.5, 0.5], ['底部', 0.5, 0.92], ['左下', 0.06, 0.92], ['右下', 0.94, 0.92]] as const).map(([label, x, y]) => (
                                    <button key={label} onClick={() => patchSubStyle(selSub.id, { x, y })}
                                        className="flex-1 text-[10px] py-1.5 rounded border bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500">
                                        {label}
                                    </button>
                                ))}
                            </div>
                            {/* 批量：应用到全部字幕 */}
                            <button onClick={() => applyStyleToAll(selSub.id)}
                                className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-yellow-600/20 text-yellow-300 border border-yellow-700 hover:bg-yellow-600/30 font-medium">
                                <Check size={13} /> 应用到全部字幕（含位置）
                            </button>
                        </div>
                    )}
                    {panelTab === 'audio' && selAudio && (
                        <div className="p-3 border-b border-neutral-800 space-y-2.5">
                            <div className="text-xs font-bold text-neutral-300 flex items-center justify-between">
                                <span>配音属性</span>
                                <button onClick={() => { setAudios(p => p.filter(a => a.id !== selAudio.id)); setSelected(null); }} className="text-red-400 hover:text-red-300" title="删除配音"><Trash2 size={14} /></button>
                            </div>
                            <div className="text-[11px] text-neutral-500 line-clamp-2">{selAudio.text}</div>
                            <label className="block text-[11px] text-neutral-400">开始（秒）
                                <input type="number" min={0} step={0.1} value={selAudio.start.toFixed(1)}
                                    onChange={e => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, start: Math.max(0, Number(e.target.value)) } : a))}
                                    className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                            </label>
                            <div className="flex items-center gap-2">
                                <button onClick={() => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, muted: !a.muted } : a))}
                                    className={`text-[11px] px-2 py-1.5 rounded border ${selAudio.muted ? 'bg-red-600/30 border-red-600 text-red-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400'}`}>
                                    {selAudio.muted ? '🔇 已静音' : '🔊 开启'}
                                </button>
                                <input type="range" min={0} max={2} step={0.05} value={selAudio.volume} disabled={selAudio.muted}
                                    onChange={e => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, volume: Number(e.target.value) } : a))}
                                    className="flex-1 disabled:opacity-40" />
                                <span className="text-[10px] text-neutral-500 w-9 text-right">{Math.round(selAudio.volume * 100)}%</span>
                            </div>
                            {/* 所属音轨（上下拖动音频块也可换轨） */}
                            <div className="text-[11px] text-neutral-400">
                                所属音轨
                                <div className="flex gap-1 mt-1">
                                    {Array.from({ length: audioLanes }).map((_, L) => (
                                        <button
                                            key={L}
                                            onClick={() => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, track: L } : a))}
                                            className={`flex-1 text-[10px] py-1 rounded border ${aTrack(selAudio) === L ? 'bg-purple-600/40 border-purple-500 text-purple-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}
                                        >
                                            音轨{L + 1}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* 音频变速：拖动条 + 数字输入 */}
                            <label className="block text-[11px] text-neutral-400">
                                倍速 {selAudio.speed.toFixed(2)}x（变速后 {audioDur(selAudio).toFixed(1)}s）
                                <div className="flex items-center gap-2 mt-1">
                                    <input type="range" min={0.25} max={4} step={0.05} value={selAudio.speed}
                                        onChange={e => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, speed: Number(e.target.value) } : a))} className="flex-1" />
                                    <input type="number" min={0.25} max={4} step={0.05} value={selAudio.speed}
                                        onChange={e => {
                                            const v = Number(e.target.value);
                                            if (!isNaN(v)) setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, speed: Math.min(4, Math.max(0.25, v)) } : a));
                                        }}
                                        className="w-16 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-1 text-xs outline-none focus:border-purple-500" />
                                </div>
                                <div className="flex gap-1 mt-1">
                                    {[0.5, 1, 1.5, 2].map(sp => (
                                        <button key={sp} onClick={() => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, speed: sp } : a))}
                                            className={`flex-1 text-[10px] py-0.5 rounded border ${selAudio.speed === sp ? 'bg-purple-600/40 border-purple-500 text-purple-200' : 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:border-neutral-500'}`}>
                                            {sp}x
                                        </button>
                                    ))}
                                </div>
                            </label>
                            {/* 淡入淡出（导出生效） */}
                            <div className="flex gap-2">
                                <label className="flex-1 text-[11px] text-neutral-400">淡入（秒）
                                    <input type="number" min={0} max={5} step={0.5} value={selAudio.fadeIn}
                                        onChange={e => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, fadeIn: Math.max(0, Math.min(5, Number(e.target.value))) } : a))}
                                        className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                </label>
                                <label className="flex-1 text-[11px] text-neutral-400">淡出（秒）
                                    <input type="number" min={0} max={5} step={0.5} value={selAudio.fadeOut}
                                        onChange={e => setAudios(p => p.map(a => a.id === selAudio.id ? { ...a, fadeOut: Math.max(0, Math.min(5, Number(e.target.value))) } : a))}
                                        className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                </label>
                            </div>
                            <div className="text-[10px] text-neutral-600">淡入淡出在导出时生效</div>
                        </div>
                    )}

                    {/* 默认字幕样式（未选中字幕时显示；新字幕/批量字幕使用该样式） */}
                    {panelTab === 'text' && !selSub && (
                        <div className="p-3 border-b border-neutral-800 space-y-2.5">
                            <button onClick={addSubtitleAtPlayhead}
                                className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-yellow-600/20 text-yellow-300 border border-yellow-700 hover:bg-yellow-600/30 font-medium">
                                <Captions size={13} /> 在播放头处添加字幕
                            </button>

                            {/* 智能字幕：语音识别自动生成 */}
                            <div className="text-xs font-bold text-neutral-300 flex items-center gap-1.5 pt-1"><Sparkles size={13} className="text-cyan-400" /> 智能字幕</div>
                            <div className="text-[10px] text-neutral-600">识别语音内容，按语音时间自动生成字幕（使用下方默认样式）。接口可在「设置 → 语音识别」中配置</div>
                            <div className="grid grid-cols-2 gap-1.5">
                                <button
                                    onClick={() => handleSmartSubtitles('video')}
                                    disabled={transcribing || clips.length === 0}
                                    className="flex items-center justify-center gap-1 text-[11px] py-2 rounded bg-cyan-600/20 text-cyan-300 border border-cyan-700 hover:bg-cyan-600/30 disabled:opacity-40 font-medium"
                                    title="识别时间轴上视频片段的原声"
                                >
                                    {transcribing ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />} 识别视频原声
                                </button>
                                <button
                                    onClick={() => handleSmartSubtitles('audio')}
                                    disabled={transcribing || audios.length === 0}
                                    className="flex items-center justify-center gap-1 text-[11px] py-2 rounded bg-purple-600/20 text-purple-300 border border-purple-700 hover:bg-purple-600/30 disabled:opacity-40 font-medium"
                                    title="识别配音轨上的音频"
                                >
                                    {transcribing ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />} 识别配音轨
                                </button>
                            </div>
                            {transcribing && <div className="text-[10px] text-cyan-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> 正在提取音频并识别语音，请稍候…</div>}

                            <div className="text-xs font-bold text-neutral-300 flex items-center gap-1.5 pt-1"><Captions size={13} className="text-yellow-400" /> 默认字幕样式</div>
                            <div className="text-[10px] text-neutral-600">新字幕与批量生成的字幕使用此样式；选中时间轴上的字幕可单独编辑其样式</div>
                            <div className="grid grid-cols-4 gap-1.5">
                                {SUB_PRESETS.map(p => (
                                    <button key={p.name} onClick={() => setDefaultStyle(s => ({ ...s, ...p.patch }))}
                                        className="h-10 rounded-lg border border-neutral-700 hover:border-cyan-500 bg-[#161616] flex items-center justify-center text-xs font-bold transition-colors"
                                        title={p.name}>
                                        <span className="px-1 py-0.5 rounded" style={p.chipStyle}>{p.name}</span>
                                    </button>
                                ))}
                            </div>
                            <label className="block text-[11px] text-neutral-400">
                                字号 {(defaultStyle.fontScale * 100).toFixed(1)}%
                                <input type="range" min={0.02} max={0.15} step={0.002} value={defaultStyle.fontScale}
                                    onChange={e => setDefaultStyle(s => ({ ...s, fontScale: Number(e.target.value) }))} className="mt-1 w-full" />
                            </label>
                            <label className="block text-[11px] text-neutral-400">
                                最大宽度 {Math.round((defaultStyle.maxW ?? 0.9) * 100)}%（超出自动换行）
                                <input type="range" min={0.3} max={1} step={0.05} value={defaultStyle.maxW ?? 0.9}
                                    onChange={e => setDefaultStyle(s => ({ ...s, maxW: Number(e.target.value) }))} className="mt-1 w-full" />
                            </label>
                            <div className="flex gap-3">
                                <label className="flex-1 text-[11px] text-neutral-400">字体颜色
                                    <input type="color" value={defaultStyle.color}
                                        onChange={e => setDefaultStyle(s => ({ ...s, color: e.target.value }))}
                                        className="mt-1 w-full h-7 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                </label>
                                <label className="flex-1 text-[11px] text-neutral-400">描边颜色
                                    <input type="color" value={defaultStyle.outlineColor}
                                        onChange={e => setDefaultStyle(s => ({ ...s, outlineColor: e.target.value }))}
                                        className="mt-1 w-full h-7 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                </label>
                            </div>
                            <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1.5 text-[11px] text-neutral-400 cursor-pointer">
                                    <input type="checkbox" checked={defaultStyle.background}
                                        onChange={e => setDefaultStyle(s => ({ ...s, background: e.target.checked }))} className="accent-yellow-500" />
                                    背景气泡
                                </label>
                                {defaultStyle.background && (
                                    <input type="color" value={defaultStyle.backgroundColor}
                                        onChange={e => setDefaultStyle(s => ({ ...s, backgroundColor: e.target.value }))}
                                        className="flex-1 h-6 bg-neutral-900 border border-neutral-700 rounded cursor-pointer" />
                                )}
                            </div>
                            {defaultStyle.background && (
                                <label className="block text-[11px] text-neutral-400">
                                    气泡不透明度 {Math.round((defaultStyle.bgOpacity ?? 0.85) * 100)}%
                                    <input type="range" min={0.1} max={1} step={0.05} value={defaultStyle.bgOpacity ?? 0.85}
                                        onChange={e => setDefaultStyle(s => ({ ...s, bgOpacity: Number(e.target.value) }))} className="mt-1 w-full" />
                                </label>
                            )}
                            <div className="text-[11px] text-neutral-400">入场动画（新生成字幕默认）</div>
                            <div className="flex gap-1.5">
                                {SUB_ANIMS.map(a => (
                                    <button key={a.id} onClick={() => setDefaultStyle(s => ({ ...s, anim: a.id }))}
                                        className={`flex-1 text-[10px] py-1.5 rounded border ${(defaultStyle.anim ?? 'none') === a.id ? 'bg-yellow-600/30 border-yellow-600 text-yellow-300' : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500'}`}>
                                        {a.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* 智能配音面板（声音 Tab） */}
                    {panelTab === 'audio' && (
                    <div className="p-3 space-y-2.5">
                        <div className="text-xs font-bold text-neutral-300 flex items-center gap-1.5"><Mic size={13} className="text-purple-400" /> 智能配音 + 字幕</div>
                        <select value={voice} onChange={e => setVoice(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none">
                            {(voices.length ? voices : [{ id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声）' }]).map(v => (
                                <option key={v.id} value={v.id}>{v.name}</option>
                            ))}
                        </select>
                        <input
                            value={scriptPrompt}
                            onChange={e => setScriptPrompt(e.target.value)}
                            placeholder="视频主题（供 AI 写解说词）"
                            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                        />
                        <button onClick={handleGenerateScript} disabled={generatingScript}
                            className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-purple-600/20 text-purple-300 border border-purple-800 hover:bg-purple-600/30 disabled:opacity-50">
                            {generatingScript ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} AI 生成解说脚本
                        </button>
                        <textarea
                            value={script}
                            onChange={e => setScript(e.target.value)}
                            rows={5}
                            placeholder="配音脚本（每句话用句号分隔，将逐句生成语音和字幕）"
                            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 resize-none"
                        />
                        <button onClick={handleGenerateVoiceAndSubs} disabled={generatingTTS || !script.trim()}
                            className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium">
                            {generatingTTS ? (<><Loader2 size={13} className="animate-spin" /> {ttsProgress || '合成中…'}</>) : (<><Mic size={13} /> 生成配音 + 字幕（从播放头处）</>)}
                        </button>
                        <button onClick={() => musicFileRef.current?.click()} disabled={importingMusic}
                            className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded bg-green-600/20 text-green-300 border border-green-800 hover:bg-green-600/30 disabled:opacity-50">
                            {importingMusic ? <Loader2 size={13} className="animate-spin" /> : '🎵'} 导入本地音乐到配音轨
                        </button>
                    </div>
                    )}

                    {/* ===== 贴纸 Tab ===== */}
                    {panelTab === 'sticker' && (
                        <div className="p-3 space-y-2.5">
                            {selSticker && (
                                <div className="space-y-2.5 pb-2 border-b border-neutral-800">
                                    <div className="text-xs font-bold text-neutral-300 flex items-center justify-between">
                                        <span>贴纸属性 <span className="text-lg ml-1">{selSticker.emoji}</span></span>
                                        <button onClick={() => { setStickers(p => p.filter(s => s.id !== selSticker.id)); setSelected(null); }} className="text-red-400 hover:text-red-300" title="删除贴纸"><Trash2 size={14} /></button>
                                    </div>
                                    <label className="block text-[11px] text-neutral-400">大小 {Math.round(selSticker.size * 100)}%
                                        <input type="range" min={0.05} max={0.8} step={0.01} value={selSticker.size}
                                            onChange={e => setStickers(p => p.map(s => s.id === selSticker.id ? { ...s, size: Number(e.target.value) } : s))}
                                            className="mt-1 w-full" />
                                    </label>
                                    <div className="flex gap-2">
                                        <label className="flex-1 text-[11px] text-neutral-400">开始
                                            <input type="number" min={0} step={0.1} value={selSticker.start.toFixed(1)}
                                                onChange={e => setStickers(p => p.map(s => s.id === selSticker.id ? { ...s, start: Math.max(0, Number(e.target.value)) } : s))}
                                                className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                        </label>
                                        <label className="flex-1 text-[11px] text-neutral-400">结束
                                            <input type="number" min={selSticker.start + 0.2} step={0.1} value={selSticker.end.toFixed(1)}
                                                onChange={e => setStickers(p => p.map(s => s.id === selSticker.id ? { ...s, end: Math.max(s.start + 0.2, Number(e.target.value)) } : s))}
                                                className="mt-1 w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs outline-none" />
                                        </label>
                                    </div>
                                    <div className="text-[10px] text-neutral-600">在预览画面上可直接拖拽贴纸调整位置</div>
                                </div>
                            )}
                            <div className="text-xs font-bold text-neutral-300">贴纸库（点击添加到播放头处，共 {STICKER_GROUPS.reduce((s, g) => s + g.emojis.length, 0)} 个）</div>
                            {STICKER_GROUPS.map(group => (
                                <div key={group.name}>
                                    <div className="text-[10px] text-neutral-500 font-bold mb-1">{group.name}</div>
                                    <div className="grid grid-cols-6 gap-1.5">
                                        {group.emojis.map(em => (
                                            <button key={em} onClick={() => addSticker(em)}
                                                className="h-10 rounded-lg border border-neutral-700 hover:border-cyan-500 bg-[#161616] flex items-center justify-center text-xl transition-colors"
                                                title={`添加 ${em}`}>
                                                {em}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ===== 特效 Tab ===== */}
                    {panelTab === 'fx' && (
                        <div className="p-3 space-y-2.5">
                            {!selClip ? (
                                <div className="text-xs text-neutral-600 text-center py-6">先在时间轴选中一个视频片段<br />再选择要应用的特效</div>
                            ) : (
                                <>
                                    <div className="text-xs font-bold text-neutral-300">画面特效（应用到选中片段）</div>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {FX_PRESETS.map(fx => {
                                            const active = (selClip.effect || 'none') === fx.id;
                                            return (
                                                <button key={fx.id}
                                                    onClick={() => updateClip(selClip.id, { effect: fx.id === 'none' ? null : fx.id })}
                                                    className={`h-14 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors ${active ? 'border-cyan-400 bg-cyan-900/30 text-cyan-200' : 'border-neutral-700 bg-[#161616] text-neutral-400 hover:border-neutral-500'}`}>
                                                    <div className="w-8 h-5 rounded-sm overflow-hidden relative" style={{ background: 'linear-gradient(120deg,#e66465,#9198e5)', filter: fx.css || undefined }}>
                                                        {fx.dark && <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse, transparent 40%, rgba(0,0,0,0.7) 100%)' }} />}
                                                    </div>
                                                    <span className="text-[10px]">{fx.name}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div className="text-[10px] text-neutral-600">预览为近似效果，导出由 ffmpeg 精确渲染</div>
                                </>
                            )}
                        </div>
                    )}

                    {/* ===== 转场 Tab ===== */}
                    {panelTab === 'trans' && (
                        <div className="p-3 space-y-2.5">
                            {clips.length < 2 ? (
                                <div className="text-xs text-neutral-600 text-center py-6">时间轴至少要有 2 个片段<br />才能添加转场</div>
                            ) : (
                                <>
                                    <div className="text-xs font-bold text-neutral-300">转场库</div>
                                    <label className="flex items-center gap-2 text-[11px] text-orange-300 cursor-pointer bg-orange-950/30 border border-orange-900 rounded px-2 py-1.5">
                                        <input type="checkbox" checked={transApplyAll} onChange={e => setTransApplyAll(e.target.checked)} className="accent-orange-500" />
                                        批量模式：点击转场时应用到全部衔接处
                                    </label>
                                    <div className="text-[10px] text-neutral-600">
                                        {transApplyAll ? '点击下方转场将统一应用到所有片段之间' : `点击应用到${selClip && clips.findIndex(c => c.id === selClip.id) < clips.length - 1 ? '选中片段之后的衔接处' : '播放头附近的衔接处'}；也可点时间轴片段之间的 ⇄ 按钮单独设置`}
                                    </div>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {TRANSITIONS.map(t => (
                                            <button key={t.id}
                                                onClick={() => {
                                                    if (transApplyAll) {
                                                        // 批量：应用到全部衔接处
                                                        setTransitions(clips.slice(0, -1).map((_, k) => ({ type: t.id, duration: transitions[k]?.duration || 0.5 })));
                                                        return;
                                                    }
                                                    // 目标衔接位：选中片段之后；否则播放头所在片段之后
                                                    let j = -1;
                                                    if (selClip) {
                                                        const i = clips.findIndex(c => c.id === selClip.id);
                                                        if (i >= 0 && i < clips.length - 1) j = i;
                                                    }
                                                    if (j < 0) {
                                                        const { idx } = findClipAt(playheadRef.current);
                                                        j = Math.min(idx, clips.length - 2);
                                                    }
                                                    if (j < 0) j = 0;
                                                    setTransitions(prev => {
                                                        const next = [...prev];
                                                        while (next.length < clips.length - 1) next.push({ type: 'none', duration: 0.5 });
                                                        next[j] = { type: t.id, duration: next[j]?.duration || 0.5 };
                                                        return next;
                                                    });
                                                }}
                                                className="h-12 rounded-lg border border-neutral-700 bg-[#161616] hover:border-orange-500 flex flex-col items-center justify-center gap-0.5 text-neutral-300 transition-colors">
                                                <ArrowLeftRight size={13} className="text-orange-400" />
                                                <span className="text-[10px]">{t.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                    <div className="text-xs font-bold text-neutral-300 pt-1">当前转场</div>
                                    <div className="space-y-1">
                                        {clips.slice(0, -1).map((c, i) => (
                                            <div key={c.id} className="flex items-center justify-between text-[11px] bg-neutral-900 rounded px-2 py-1.5 border border-neutral-800">
                                                <span className="text-neutral-500 truncate flex-1">{i + 1} → {i + 2}</span>
                                                <span className={transitions[i]?.type && transitions[i].type !== 'none' ? 'text-orange-300' : 'text-neutral-600'}>
                                                    {TRANSITIONS.find(t => t.id === (transitions[i]?.type || 'none'))?.name}
                                                    {transitions[i]?.type && transitions[i].type !== 'none' ? ` · ${transitions[i].duration}s` : ''}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    </div>
                </div>
            </div>

            {/* ===== 底部时间轴（顶边拖动调高度，轨道多时内部上下滚动） ===== */}
            <div
                className="relative border-t border-neutral-800 flex flex-col flex-shrink-0 bg-[#0e0e0e]"
                style={{ height: timelineH }}
            >
                {/* 高度拖动手柄 */}
                <div
                    onPointerDown={onTlResizeDown}
                    onPointerMove={onTlResizeMove}
                    onPointerUp={onTlResizeUp}
                    className="absolute -top-1 inset-x-0 h-2 cursor-ns-resize z-[80] hover:bg-cyan-500/40 transition-colors"
                    title="上下拖动调整时间轴高度"
                />
                {/* 多选浮动工具栏 */}
                {multiSel.size > 0 && (
                    <div className="absolute -top-10 right-4 z-[60] flex items-center gap-2 px-3 py-1.5 bg-neutral-900/95 border border-neutral-700 rounded-full shadow-2xl text-[11px] backdrop-blur-sm">
                        <span className="text-cyan-300 font-medium">已选 {multiSel.size} 项</span>
                        <span className="text-neutral-600">拖动整体移动（视频片段除外）</span>
                        <button
                            onClick={deleteMultiSelected}
                            className="flex items-center gap-1 px-2 py-1 rounded-full bg-red-600/30 hover:bg-red-600/60 border border-red-700 text-red-300"
                        >
                            <Trash2 size={11} /> 删除
                        </button>
                        <button
                            onClick={() => setMultiSel(new Set())}
                            className="px-2 py-1 rounded-full bg-neutral-800 hover:bg-neutral-700 text-neutral-400"
                        >
                            取消 (Esc)
                        </button>
                    </div>
                )}
                {/* 纵向滚动容器：轨道头与轨道内容一起上下滚动 */}
                <div className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#404040 #0e0e0e' }}>
                {/* 内层自然高度的行：内容超出时撑开滚动，而不是压缩行高 */}
                <div className="flex min-h-full">
                {/* 轨道头（固定列，与各轨行高对齐） */}
                <div className="w-16 flex-shrink-0 border-r border-neutral-800 bg-[#121212] flex flex-col select-none">
                    <div className="h-6 border-b border-neutral-800 flex-shrink-0" />
                    <div className="h-12 flex-shrink-0 flex flex-col items-center justify-center gap-0.5 border-b border-neutral-900">
                        <span className="text-[10px] text-neutral-400 font-medium">视频</span>
                        <button
                            onClick={() => setVideoTrackMuted(m => !m)}
                            className={`px-1.5 rounded text-[10px] ${videoTrackMuted ? 'bg-red-600/40 text-red-300' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
                            title={videoTrackMuted ? '取消视频轨整体静音' : '视频轨整体静音（所有片段原声）'}
                        >
                            {videoTrackMuted ? '🔇' : '🔊'}
                        </button>
                    </div>
                    {Array.from({ length: overlayLanes }).map((_, L) => {
                        const laneEmpty = !overlays.some(o => oTrack(o) === L);
                        const isLast = L === overlayLanes - 1;
                        return (
                            <div key={`ovh${L}`} className="h-12 flex-shrink-0 flex flex-col items-center justify-center gap-0.5 border-b border-neutral-900">
                                <span className="text-[10px] text-amber-400/80 font-medium">画中画{overlayLanes > 1 ? L + 1 : ''}</span>
                                <div className="flex items-center gap-0.5">
                                    {isLast && overlayLanes < MAX_OVERLAY_LANES && (
                                        <button
                                            onClick={() => setOverlayLaneCount(overlayLanes + 1)}
                                            className="px-1 rounded text-[10px] bg-neutral-800 text-neutral-600 hover:text-cyan-300"
                                            title="添加一条画中画轨"
                                        >
                                            ＋
                                        </button>
                                    )}
                                    {isLast && laneEmpty && overlayLanes > 1 && (
                                        <button
                                            onClick={() => setOverlayLaneCount(overlayLanes - 1)}
                                            className="px-1 rounded text-[10px] bg-neutral-800 text-neutral-600 hover:text-red-400"
                                            title="删除这条空画中画轨"
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    {Array.from({ length: audioLanes }).map((_, L) => {
                        const laneEmpty = !audios.some(a => aTrack(a) === L);
                        const isLast = L === audioLanes - 1;
                        return (
                            <div key={L} className="h-12 flex-shrink-0 flex flex-col items-center justify-center gap-0.5 border-b border-neutral-900">
                                <span className="text-[10px] text-neutral-400 font-medium">音轨{L + 1}</span>
                                <div className="flex items-center gap-0.5">
                                    <button
                                        onClick={() => setAudioLaneMuted(prev => { const n = [...prev]; n[L] = !n[L]; return n; })}
                                        className={`px-1.5 rounded text-[10px] ${audioLaneMuted[L] ? 'bg-red-600/40 text-red-300' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
                                        title={audioLaneMuted[L] ? `取消音轨${L + 1}静音` : `静音音轨${L + 1}`}
                                    >
                                        {audioLaneMuted[L] ? '🔇' : '🔊'}
                                    </button>
                                    {isLast && laneEmpty && audioLanes > 1 && (
                                        <button
                                            onClick={() => {
                                                setAudioLaneCount(audioLanes - 1);
                                                setAudioLaneMuted(prev => prev.slice(0, audioLanes - 1));
                                            }}
                                            className="px-1 rounded text-[10px] bg-neutral-800 text-neutral-600 hover:text-red-400"
                                            title="删除这条空音轨"
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    {/* 添加音轨 */}
                    <div className="h-6 flex-shrink-0 flex items-center justify-center border-b border-neutral-900">
                        <button
                            onClick={() => setAudioLaneCount(Math.min(MAX_AUDIO_LANES, audioLanes + 1))}
                            disabled={audioLanes >= MAX_AUDIO_LANES}
                            className="text-[10px] text-neutral-600 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={audioLanes >= MAX_AUDIO_LANES ? `最多 ${MAX_AUDIO_LANES} 条音轨` : '添加一条音轨（人声/背景声/BGM 分轨）'}
                        >
                            ＋ 音轨
                        </button>
                    </div>
                    <div className="h-12 flex-shrink-0 flex items-center justify-center border-b border-neutral-900">
                        <span className="text-[10px] text-neutral-400 font-medium">字幕</span>
                    </div>
                    <div className="h-12 flex-shrink-0 flex items-center justify-center border-b border-neutral-900">
                        <span className="text-[10px] text-neutral-400 font-medium">贴纸</span>
                    </div>
                </div>

                {/* 滚动区 */}
                <div ref={timelineScrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
                    <div
                        className="relative cursor-pointer"
                        style={{ width: timelineWidth, minHeight: '100%' }}
                        onPointerDown={onTimelinePointerDown}
                        onPointerMove={onTimelinePointerMove}
                        onPointerUp={onTimelinePointerUp}
                        onContextMenu={e => openCtxMenu(e, 'empty')}
                    >
                        {/* 标尺 */}
                        <div className="h-6 border-b border-neutral-800 relative bg-[#101010]">
                            {Array.from({ length: tickCount }).map((_, i) => (
                                <div key={i} className="absolute top-0 h-full" style={{ left: i * tickInterval * pxPerSec }}>
                                    <div className="w-px h-2 bg-neutral-700" />
                                    <span className="text-[9px] text-neutral-600 ml-0.5">{fmtTick(i * tickInterval)}</span>
                                </div>
                            ))}
                        </div>

                        {/* 视频轨 */}
                        <div className="h-12 relative flex items-center border-b border-neutral-900">
                            <div className="flex h-10 items-center">
                                {clips.map((c, i) => {
                                    const w = clipDur(c) * pxPerSec;
                                    const isSel = (selected?.kind === 'clip' && selected.id === c.id) || multiSel.has(`clip:${c.id}`);
                                    const dragDx = clipDragOffset?.id === c.id ? clipDragOffset.dx : 0;
                                    return (
                                        <React.Fragment key={c.id}>
                                            <div
                                                onPointerDown={e => onClipPointerDown(e, c, 'move')}
                                                onPointerMove={onClipPointerMove}
                                                onPointerUp={onClipPointerUp}
                                                onContextMenu={e => openCtxMenu(e, { kind: 'clip', id: c.id })}
                                                className={`h-10 rounded-md cursor-grab active:cursor-grabbing border-2 flex-shrink-0 relative ${isSel ? 'border-cyan-400' : 'border-neutral-700 hover:border-neutral-500'}`}
                                                style={{
                                                    width: Math.max(w, 30),
                                                    background: 'linear-gradient(135deg, #173042, #0f1f2b)',
                                                    transform: dragDx ? `translateX(${dragDx}px)` : undefined,
                                                    zIndex: dragDx ? 40 : undefined,
                                                    opacity: dragDx ? 0.85 : 1,
                                                }}
                                                title={`${c.name}（${clipDur(c).toFixed(1)}s${c.speed !== 1 ? ` · ${c.speed}x` : ''}）拖动排序 / 拖边缘裁剪`}
                                            >
                                                <div className="px-1.5 py-0.5 text-[10px] text-cyan-200 truncate pointer-events-none">{c.name}</div>
                                                <div className="px-1.5 text-[9px] text-neutral-500 flex items-center gap-1 pointer-events-none">
                                                    {clipDur(c).toFixed(1)}s
                                                    {c.speed !== 1 && <span className="px-0.5 rounded bg-cyan-700/60 text-cyan-200">{c.speed}x</span>}
                                                    {(c.muted || videoTrackMuted) && <span>🔇</span>}
                                                    {c.reverse && <span className="text-orange-400">⏪</span>}
                                                </div>
                                                {/* 左右裁剪手柄（拖动调整入点/出点） */}
                                                <div
                                                    onPointerDown={e => onClipPointerDown(e, c, 'trimL')}
                                                    onPointerMove={onClipPointerMove}
                                                    onPointerUp={onClipPointerUp}
                                                    className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-cyan-400/80' : 'bg-transparent hover:bg-cyan-500/60'}`}
                                                    title="拖动调整入点"
                                                />
                                                <div
                                                    onPointerDown={e => onClipPointerDown(e, c, 'trimR')}
                                                    onPointerMove={onClipPointerMove}
                                                    onPointerUp={onClipPointerUp}
                                                    className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-cyan-400/80' : 'bg-transparent hover:bg-cyan-500/60'}`}
                                                    title="拖动调整出点"
                                                />
                                            </div>
                                            {i < clips.length - 1 && (
                                                <div className="relative flex-shrink-0 z-20" onPointerDown={e => e.stopPropagation()}>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                            setTransPickerPos({ x: r.left + r.width / 2, y: r.top });
                                                            setTransPickerIdx(transPickerIdx === i ? null : i);
                                                        }}
                                                        className={`w-6 h-6 -mx-3 rounded-full border flex items-center justify-center relative z-20 ${transitions[i]?.type && transitions[i].type !== 'none' ? 'bg-orange-500/90 border-orange-300 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:text-white'}`}
                                                        title={`转场：${TRANSITIONS.find(t => t.id === (transitions[i]?.type || 'none'))?.name}`}
                                                    >
                                                        <ArrowLeftRight size={11} />
                                                    </button>
                                                    {transPickerIdx === i && (
                                                        <>
                                                        {/* 点击空白处关闭 */}
                                                        <div className="fixed inset-0 z-[290]" onPointerDown={e => { e.stopPropagation(); setTransPickerIdx(null); }} />
                                                        <div
                                                            className="fixed w-52 bg-[#1d1d1d] border border-neutral-700 rounded-lg shadow-2xl z-[300] py-1"
                                                            style={{ left: transPickerPos.x, top: transPickerPos.y - 8, transform: 'translate(-50%, -100%)' }}
                                                            onPointerDown={e => e.stopPropagation()}
                                                        >
                                                            <div className="max-h-60 overflow-y-auto grid grid-cols-2">
                                                            {TRANSITIONS.map(t => (
                                                                <button
                                                                    key={t.id}
                                                                    onClick={() => {
                                                                        setTransitions(prev => {
                                                                            const next = [...prev];
                                                                            while (next.length < clips.length - 1) next.push({ type: 'none', duration: 0.5 });
                                                                            next[i] = { type: t.id, duration: next[i]?.duration || 0.5 };
                                                                            return next;
                                                                        });
                                                                        setTransPickerIdx(null);
                                                                    }}
                                                                    className={`flex items-center justify-between px-2.5 py-1.5 text-[11px] text-left hover:bg-neutral-800 ${(transitions[i]?.type || 'none') === t.id ? 'text-cyan-300' : 'text-neutral-300'}`}
                                                                >
                                                                    <span className="truncate">{t.name}</span>
                                                                    {(transitions[i]?.type || 'none') === t.id && <Check size={11} className="text-cyan-400 flex-shrink-0" />}
                                                                </button>
                                                            ))}
                                                            </div>
                                                            <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-2">
                                                                <span className="text-[10px] text-neutral-500">时长</span>
                                                                {[0.5, 1, 1.5].map(d => (
                                                                    <button key={d}
                                                                        onClick={() => setTransitions(prev => { const n = [...prev]; n[i] = { ...(n[i] || { type: 'fade' }), duration: d }; return n; })}
                                                                        className={`text-[10px] px-1.5 py-0.5 rounded ${(transitions[i]?.duration || 0.5) === d ? 'bg-cyan-600 text-white' : 'bg-neutral-800 text-neutral-400'}`}>
                                                                        {d}s
                                                                    </button>
                                                                ))}
                                                            </div>
                                                            <button
                                                                onClick={() => {
                                                                    const t = transitions[i] || { type: 'fade', duration: 0.5 };
                                                                    setTransitions(clips.slice(0, -1).map(() => ({ ...t })));
                                                                    setTransPickerIdx(null);
                                                                }}
                                                                className="w-full text-[11px] py-1.5 border-t border-neutral-800 text-orange-300 hover:bg-neutral-800 flex items-center justify-center gap-1"
                                                            >
                                                                <Check size={11} /> 应用到全部衔接处
                                                            </button>
                                                        </div>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 画中画轨（自由放置，可上下拖动换轨、拖边缘裁剪；素材卡可直接拖进来） */}
                        {Array.from({ length: overlayLanes }).map((_, L) => (
                        <div
                            key={`ovlane${L}`}
                            className="h-12 relative border-b border-neutral-900"
                            onDragOver={e => {
                                if (e.dataTransfer.types.includes('application/x-library-asset')) {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'copy';
                                }
                            }}
                            onDrop={e => {
                                const raw = e.dataTransfer.getData('application/x-library-asset');
                                if (!raw) return;
                                e.preventDefault();
                                e.stopPropagation();
                                try {
                                    const asset = JSON.parse(raw) as LibraryAsset;
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const start = Math.max(0, (e.clientX - rect.left) / pxPerSec);
                                    addOverlayFromLibrary(asset, { start, track: L });
                                } catch { /* 非法拖拽数据，忽略 */ }
                            }}
                        >
                            {overlays.filter(o => oTrack(o) === L).map(o => {
                                const isSel = (selected?.kind === 'overlay' && selected.id === o.id) || multiSel.has(`overlay:${o.id}`);
                                return (
                                    <div
                                        key={o.id}
                                        onPointerDown={e => onItemPointerDown(e, 'overlay', o.id, o.start)}
                                        onPointerMove={onItemPointerMove}
                                        onPointerUp={onItemPointerUp}
                                        onContextMenu={e => openCtxMenu(e, { kind: 'overlay', id: o.id })}
                                        className={`absolute top-1 h-10 rounded-md cursor-grab active:cursor-grabbing border-2 px-1.5 overflow-hidden ${isSel ? 'border-amber-400' : 'border-amber-900/80 hover:border-amber-600'}`}
                                        style={{
                                            left: o.start * pxPerSec,
                                            width: Math.max(clipDur(o) * pxPerSec, 24),
                                            background: 'linear-gradient(135deg, #33270e, #201807)',
                                        }}
                                        title={`画中画：${o.name}（${clipDur(o).toFixed(1)}s）拖动移动 / 上下换轨 / 拖边缘裁剪`}
                                    >
                                        <div className="h-full flex items-center gap-1 text-[10px] text-amber-200 truncate pointer-events-none">
                                            ⧉ {o.name}
                                            {o.speed !== 1 && <span className="px-0.5 rounded bg-black/40">{o.speed}x</span>}
                                            {(o.muted || videoTrackMuted) && ' 🔇'}
                                        </div>
                                        <div
                                            onPointerDown={e => onOverlayTrimDown(e, o, 'L')}
                                            onPointerMove={onOverlayTrimMove}
                                            onPointerUp={onOverlayTrimUp}
                                            className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-amber-400/80' : 'hover:bg-amber-500/60'}`}
                                            title="拖动裁剪开头"
                                        />
                                        <div
                                            onPointerDown={e => onOverlayTrimDown(e, o, 'R')}
                                            onPointerMove={onOverlayTrimMove}
                                            onPointerUp={onOverlayTrimUp}
                                            className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-amber-400/80' : 'hover:bg-amber-500/60'}`}
                                            title="拖动裁剪结尾"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                        ))}

                        {/* 配音轨（多音轨：人声/背景声/BGM 分轨，音频块可上下拖动换轨） */}
                        {Array.from({ length: audioLanes }).map((_, L) => (
                        <div key={`lane${L}`} className="h-12 relative border-b border-neutral-900">
                            {audios.filter(a => aTrack(a) === L).map(a => {
                                const isSel = (selected?.kind === 'audio' && selected.id === a.id) || multiSel.has(`audio:${a.id}`);
                                return (
                                    <div
                                        key={a.id}
                                        onPointerDown={e => onItemPointerDown(e, 'audio', a.id, a.start)}
                                        onPointerMove={onItemPointerMove}
                                        onPointerUp={onItemPointerUp}
                                        onContextMenu={e => openCtxMenu(e, { kind: 'audio', id: a.id })}
                                        className={`absolute top-1 h-10 rounded-md cursor-grab active:cursor-grabbing border-2 px-1.5 overflow-hidden ${a.isMusic ? (isSel ? 'border-green-400' : 'border-green-900 hover:border-green-600') : (isSel ? 'border-purple-400' : 'border-purple-900 hover:border-purple-600')}`}
                                        style={{
                                            left: a.start * pxPerSec,
                                            width: Math.max(audioDur(a) * pxPerSec, 24),
                                            background: a.isMusic ? 'linear-gradient(135deg, #11331f, #0a2014)' : 'linear-gradient(135deg, #2a1a40, #1a1028)',
                                        }}
                                        title={`${a.text}${a.speed !== 1 ? ` · ${a.speed}x` : ''}`}
                                    >
                                        <div className={`h-full flex items-center text-[10px] truncate pointer-events-none ${a.isMusic ? 'text-green-300' : 'text-purple-300'}`}>
                                            {a.isMusic ? '' : '🎙 '}{a.text}
                                            {a.speed !== 1 && <span className="ml-1 px-0.5 rounded bg-black/40">{a.speed}x</span>}
                                            {(a.muted || audioTrackMuted || audioLaneMuted[L]) && ' 🔇'}
                                        </div>
                                        {/* 左右裁剪手柄 */}
                                        <div
                                            onPointerDown={e => onAudioTrimDown(e, a, 'L')}
                                            onPointerMove={onAudioTrimMove}
                                            onPointerUp={onAudioTrimUp}
                                            className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-purple-400/80' : 'hover:bg-purple-500/60'}`}
                                            title="拖动裁剪开头"
                                        />
                                        <div
                                            onPointerDown={e => onAudioTrimDown(e, a, 'R')}
                                            onPointerMove={onAudioTrimMove}
                                            onPointerUp={onAudioTrimUp}
                                            className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-purple-400/80' : 'hover:bg-purple-500/60'}`}
                                            title="拖动裁剪结尾"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                        ))}
                        {/* 添加音轨行（与轨道头对齐的空行） */}
                        <div className="h-6 border-b border-neutral-900" />

                        {/* 字幕轨 */}
                        <div className="h-12 relative border-b border-neutral-900">
                            {subtitles.map(s => {
                                const isSel = (selected?.kind === 'sub' && selected.id === s.id) || multiSel.has(`sub:${s.id}`);
                                return (
                                    <div
                                        key={s.id}
                                        onPointerDown={e => onItemPointerDown(e, 'sub', s.id, s.start)}
                                        onPointerMove={onItemPointerMove}
                                        onPointerUp={onItemPointerUp}
                                        onContextMenu={e => openCtxMenu(e, { kind: 'sub', id: s.id })}
                                        className={`absolute top-1 h-10 rounded-md cursor-grab active:cursor-grabbing border-2 px-1.5 overflow-hidden ${isSel ? 'border-yellow-400' : 'border-yellow-900/80 hover:border-yellow-600'}`}
                                        style={{
                                            left: s.start * pxPerSec,
                                            width: Math.max((s.end - s.start) * pxPerSec, 24),
                                            background: 'linear-gradient(135deg, #332a10, #201a08)',
                                        }}
                                        title={`${s.text}（拖动移动 / 拖边缘调时长）`}
                                    >
                                        <div className="h-full flex items-center text-[10px] text-yellow-200 truncate pointer-events-none">T {s.text}</div>
                                        <div
                                            onPointerDown={e => onSubTrimDown(e, s, 'L')}
                                            onPointerMove={onSubTrimMove}
                                            onPointerUp={onSubTrimUp}
                                            className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-yellow-400/80' : 'hover:bg-yellow-500/60'}`}
                                        />
                                        <div
                                            onPointerDown={e => onSubTrimDown(e, s, 'R')}
                                            onPointerMove={onSubTrimMove}
                                            onPointerUp={onSubTrimUp}
                                            className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize ${isSel ? 'bg-yellow-400/80' : 'hover:bg-yellow-500/60'}`}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        {/* 贴纸轨（恒显） */}
                        <div className="h-12 relative border-b border-neutral-900">
                            {stickers.map(s => {
                                const isSel = (selected?.kind === 'sticker' && selected.id === s.id) || multiSel.has(`sticker:${s.id}`);
                                return (
                                    <div
                                        key={s.id}
                                        onPointerDown={e => onItemPointerDown(e, 'sticker', s.id, s.start)}
                                        onPointerMove={onItemPointerMove}
                                        onPointerUp={onItemPointerUp}
                                        onContextMenu={e => openCtxMenu(e, { kind: 'sticker', id: s.id })}
                                        className={`absolute top-1 h-10 rounded-md cursor-grab active:cursor-grabbing border-2 px-1.5 overflow-hidden ${isSel ? 'border-cyan-400' : 'border-cyan-900/80 hover:border-cyan-600'}`}
                                        style={{
                                            left: s.start * pxPerSec,
                                            width: Math.max((s.end - s.start) * pxPerSec, 24),
                                            background: 'linear-gradient(135deg, #0e2e33, #081d20)',
                                        }}
                                        title={`贴纸 ${s.emoji}（拖动移动时间）`}
                                    >
                                        <div className="h-full flex items-center text-sm truncate pointer-events-none">{s.emoji}</div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* 播放头 */}
                        <div className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none" style={{ left: playhead * pxPerSec }}>
                            <div className="w-2.5 h-2.5 -ml-[5px] bg-red-500 rotate-45" />
                        </div>

                        {/* 框选矩形 */}
                        {marquee && (
                            <div
                                className="absolute border border-cyan-400 bg-cyan-400/10 z-40 pointer-events-none rounded-sm"
                                style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                            />
                        )}
                    </div>
                </div>
                </div>
                </div>
            </div>

            {/* ===== 右键菜单 ===== */}
            {ctxMenu && (
                <>
                    <div
                        className="fixed inset-0 z-[390]"
                        onPointerDown={() => setCtxMenu(null)}
                        onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }}
                    />
                    <div
                        className="fixed w-44 bg-[#1d1d1d] border border-neutral-700 rounded-lg shadow-2xl z-[400] py-1"
                        style={{
                            left: Math.min(ctxMenu.x, window.innerWidth - 185),
                            top: Math.min(ctxMenu.y, window.innerHeight - 260),
                        }}
                        onPointerDown={e => e.stopPropagation()}
                    >
                        {ctxMenu.target !== 'empty' ? (
                            <>
                                <button
                                    onClick={() => { copyItem((ctxMenu.target as any).kind, (ctxMenu.target as any).id); setCtxMenu(null); }}
                                    className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200"
                                >
                                    复制 <span className="text-[10px] text-neutral-500">Ctrl+C</span>
                                </button>
                                <button
                                    onClick={() => {
                                        const t = ctxMenu.target as { kind: ItemKind; id: string };
                                        copyItem(t.kind, t.id);
                                        deleteItem(t.kind, t.id);
                                        setCtxMenu(null);
                                    }}
                                    className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200"
                                >
                                    剪切 <span className="text-[10px] text-neutral-500">Ctrl+X</span>
                                </button>
                                <button
                                    onClick={() => { pasteClipboard(); setCtxMenu(null); }}
                                    disabled={!clipboardRef.current}
                                    className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    粘贴 <span className="text-[10px] text-neutral-500">Ctrl+V</span>
                                </button>
                                {(ctxMenu.target as any).kind === 'clip' && (
                                    <>
                                        <button
                                            onClick={() => { splitAtPlayhead(); setCtxMenu(null); }}
                                            className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200 border-t border-neutral-800"
                                        >
                                            在播放头处分割
                                        </button>
                                        <button
                                            onClick={() => { detachAudioFromClip((ctxMenu.target as any).id); setCtxMenu(null); }}
                                            className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200"
                                            title="把片段原声提取为独立音频条目（片段本身静音）"
                                        >
                                            分离音频
                                        </button>
                                        <button
                                            onClick={() => { convertClipToOverlay((ctxMenu.target as any).id); setCtxMenu(null); }}
                                            className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200"
                                            title="把该片段从主轨移到画中画轨（保留裁剪/变速）"
                                        >
                                            转为画中画
                                        </button>
                                    </>
                                )}
                                {(ctxMenu.target as any).kind === 'audio' && (
                                    <button
                                        onClick={() => { splitAtPlayhead(); setCtxMenu(null); }}
                                        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200 border-t border-neutral-800"
                                    >
                                        在播放头处分割
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        const t = ctxMenu.target as { kind: ItemKind; id: string };
                                        deleteItem(t.kind, t.id);
                                        setCtxMenu(null);
                                    }}
                                    className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-red-400 border-t border-neutral-800"
                                >
                                    删除 <span className="text-[10px] text-neutral-500">Del</span>
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => { pasteClipboard(); setCtxMenu(null); }}
                                disabled={!clipboardRef.current}
                                className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-neutral-800 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                粘贴到播放头处 <span className="text-[10px] text-neutral-500">Ctrl+V</span>
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
