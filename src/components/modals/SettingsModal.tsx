/**
 * SettingsModal.tsx
 *
 * 应用内“设置”弹窗：用于填写并保存各类 API 密钥。
 * 密钥保存在后端配置文件中，保存后立即生效（无需重启）。
 */

import React, { useEffect, useState } from 'react';
import { Loader2, X, Eye, EyeOff } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface FieldDef {
    key: string;
    label: string;
    placeholder?: string;
    hint?: string;
}

interface GroupDef {
    title: string;
    desc?: string;
    fields: FieldDef[];
}

const GROUPS: GroupDef[] = [
    {
        title: '文字模型',
        desc: '用于 AI 聊天助手。接口需兼容 OpenAI Chat（/chat/completions）。',
        fields: [
            { key: 'TEXT_API_URL', label: '网址 (Base URL)', placeholder: 'https://www.gpt2api.com/v1', hint: '接入地址，例如 https://www.gpt2api.com/v1' },
            { key: 'TEXT_API_KEY', label: 'KEY (API Key)', hint: 'sk- 开头的密钥' },
            { key: 'TEXT_MODEL', label: '模型名', placeholder: 'grok-4.20-fast', hint: '例如 grok-4.20-fast / grok-4.20-heavy' },
        ],
    },
    {
        title: '图片模型',
        desc: '用于图像生成 / 图生图。接口需兼容 OpenAI Images（/images/generations）。',
        fields: [
            { key: 'IMAGE_API_URL', label: '网址 (Base URL)', placeholder: 'https://www.gpt2api.com/v1', hint: '接入地址，例如 https://www.gpt2api.com/v1' },
            { key: 'IMAGE_API_KEY', label: 'KEY (API Key)', hint: 'sk- 开头的密钥' },
            { key: 'IMAGE_MODEL', label: '模型名', placeholder: 'nano-banana-pro', hint: '例如 nano-banana-pro / nano-banana-v2 / gpt-image-2' },
        ],
    },
    {
        title: '视频模型',
        desc: '用于视频生成 / 图生视频。接口需兼容 /video/generations（异步任务 + 轮询）。',
        fields: [
            { key: 'VIDEO_API_URL', label: '网址 (Base URL)', placeholder: 'https://www.gpt2api.com/v1', hint: '接入地址，例如 https://www.gpt2api.com/v1' },
            { key: 'VIDEO_API_KEY', label: 'KEY (API Key)', hint: 'sk- 开头的密钥' },
            { key: 'VIDEO_MODEL', label: '模型名', placeholder: 'veo3.1-lite', hint: '例如 veo3.1-lite / veo3.1 / sora / grok-imagine-video' },
        ],
    },
    {
        title: '语音识别（智能字幕）',
        desc: '剪辑工作室「智能字幕」使用。支持小米 MiMo ASR（mimo-v2.5-asr）和 OpenAI Whisper 兼容接口（/audio/transcriptions）。留空时复用文字模型的网址和 KEY。',
        fields: [
            { key: 'ASR_API_URL', label: '网址 (Base URL)', placeholder: 'https://api.xiaomimimo.com/v1', hint: 'MiMo 或支持 /audio/transcriptions 的服务地址' },
            { key: 'ASR_API_KEY', label: 'KEY (API Key)', hint: '留空则复用文字模型 KEY' },
            { key: 'ASR_MODEL', label: '模型名', placeholder: 'mimo-v2.5-asr', hint: '例如 mimo-v2.5-asr / whisper-1' },
        ],
    },
];

// 仅 *_API_KEY 字段以密码形式遮蔽；网址、模型名以明文显示
const SECRET_KEYS = new Set(
    GROUPS.flatMap(g => g.fields.map(f => f.key)).filter(k => k.endsWith('API_KEY'))
);

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
    const [values, setValues] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedTip, setSavedTip] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [revealed, setRevealed] = useState<Record<string, boolean>>({});

    useEffect(() => {
        if (!isOpen) return;
        setError(null);
        setSavedTip(false);
        setLoading(true);
        fetch('/api/settings')
            .then(res => res.json())
            .then(data => {
                if (data && data.settings) setValues(data.settings);
            })
            .catch(err => setError('读取设置失败：' + err.message))
            .finally(() => setLoading(false));
    }, [isOpen]);

    const handleChange = (key: string, value: string) => {
        setValues(prev => ({ ...prev, [key]: value }));
        setSavedTip(false);
    };

    const toggleReveal = (key: string) => {
        setRevealed(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSave = async () => {
        try {
            setSaving(true);
            setError(null);
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: values }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || '保存失败');
            }
            setSavedTip(true);
            setTimeout(() => setSavedTip(false), 2500);
        } catch (err: any) {
            setError(err.message || '保存失败');
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[120]">
            <div className="bg-[#1a1a1a] border border-neutral-700 rounded-2xl w-[640px] max-w-[92vw] max-h-[88vh] flex flex-col shadow-2xl">
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
                    <div>
                        <h2 className="text-lg font-semibold text-white">设置</h2>
                        <p className="text-xs text-neutral-500 mt-0.5">密钥仅保存在本机，保存后立即生效</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                        title="关闭"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* 内容 */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
                    {loading ? (
                        <div className="flex items-center justify-center py-10 text-neutral-400 gap-2">
                            <Loader2 className="w-5 h-5 animate-spin" /> 正在读取设置…
                        </div>
                    ) : (
                        GROUPS.map(group => (
                            <div key={group.title}>
                                <h3 className="text-sm font-semibold text-neutral-200">{group.title}</h3>
                                {group.desc && <p className="text-xs text-neutral-500 mt-1 mb-3">{group.desc}</p>}
                                <div className="space-y-3">
                                    {group.fields.map(field => {
                                        const isSecret = SECRET_KEYS.has(field.key);
                                        const show = revealed[field.key];
                                        return (
                                            <div key={field.key}>
                                                <label className="block text-xs text-neutral-400 mb-1">{field.label}</label>
                                                <div className="relative">
                                                    <input
                                                        type={isSecret && !show ? 'password' : 'text'}
                                                        value={values[field.key] || ''}
                                                        placeholder={field.placeholder || '未设置'}
                                                        onChange={(e) => handleChange(field.key, e.target.value)}
                                                        autoComplete="off"
                                                        spellCheck={false}
                                                        className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 pr-10 text-sm text-white outline-none focus:border-blue-500 transition-colors"
                                                    />
                                                    {isSecret && (
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleReveal(field.key)}
                                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                                                            title={show ? '隐藏' : '显示'}
                                                        >
                                                            {show ? <EyeOff size={16} /> : <Eye size={16} />}
                                                        </button>
                                                    )}
                                                </div>
                                                {field.hint && <p className="text-[11px] text-neutral-600 mt-1">{field.hint}</p>}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* 底部 */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-800">
                    <div className="text-xs">
                        {error && <span className="text-red-400">{error}</span>}
                        {savedTip && !error && <span className="text-green-400">已保存，立即生效</span>}
                    </div>
                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-sm transition-colors"
                        >
                            关闭
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || loading}
                            className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {saving ? (<><Loader2 className="w-4 h-4 animate-spin" /> 保存中…</>) : '保存'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
