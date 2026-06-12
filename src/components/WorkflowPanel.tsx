/**
 * WorkflowPanel.tsx
 * 
 * Panel for browsing and managing saved workflows.
 * Shows list of workflows with options to load, delete, or edit cover.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Trash2, FileText, Loader2, Maximize2, Pencil, Check, Upload } from 'lucide-react';
import { LazyImage } from './LazyImage';
import { showAppAlert } from './ui/AppDialog';

interface WorkflowSummary {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodeCount: number;
    coverUrl?: string;
    description?: string; // For public workflows
}

interface AssetMetadata {
    id: string;
    url: string;
    prompt?: string;
    createdAt: string;
}

interface WorkflowPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onLoadWorkflow: (workflowId: string) => void;
    currentWorkflowId?: string;
    panelY?: number;
    canvasTheme?: 'dark' | 'light';
}

export const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
    isOpen,
    onClose,
    onLoadWorkflow,
    currentWorkflowId,
    panelY = 200,
    canvasTheme = 'dark'
}) => {
    const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
    const [publicWorkflows, setPublicWorkflows] = useState<WorkflowSummary[]>([]);
    const [activeTab, setActiveTab] = useState<'my' | 'public'>('my');
    const [loading, setLoading] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

    // Cover editing state
    const [editingCoverFor, setEditingCoverFor] = useState<string | null>(null);
    const [coverAssets, setCoverAssets] = useState<AssetMetadata[]>([]);
    const [loadingAssets, setLoadingAssets] = useState(false);

    // Pagination state for cover image modal
    const COVERS_PER_PAGE = 9;
    const [visibleCoverCount, setVisibleCoverCount] = useState(COVERS_PER_PAGE);
    const loadMoreRef = useRef<HTMLDivElement>(null);

    // Theme helper
    const isDark = canvasTheme === 'dark';

    // Fetch workflows on open
    useEffect(() => {
        if (isOpen) {
            fetchWorkflows();
            fetchPublicWorkflows();
        }
    }, [isOpen]);

    const fetchWorkflows = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/workflows');
            if (response.ok) {
                const data = await response.json();
                setWorkflows(data);
            }
        } catch (error) {
            console.error('Failed to fetch workflows:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchPublicWorkflows = async () => {
        try {
            const response = await fetch('/api/public-workflows');
            if (response.ok) {
                const data = await response.json();
                setPublicWorkflows(data);
            }
        } catch (error) {
            console.error('Failed to fetch public workflows:', error);
        }
    };

    const importInputRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);

    const handleImportWorkflow = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setImporting(true);
        try {
            const text = await file.text();
            const workflow = JSON.parse(text);
            // 作为新的「我的工作流」导入：分配新 ID，标题缺省用文件名
            workflow.id = (crypto as any).randomUUID ? crypto.randomUUID() : `wf_${Date.now()}`;
            if (!workflow.title) {
                workflow.title = file.name.replace(/\.json$/i, '');
            }
            const response = await fetch('/api/workflows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(workflow)
            });
            if (!response.ok) throw new Error('导入失败');
            setActiveTab('my');
            await fetchWorkflows();
        } catch (err) {
            console.error('Import workflow failed:', err);
            showAppAlert('导入失败：文件不是有效的工作流 JSON');
        } finally {
            setImporting(false);
            if (importInputRef.current) importInputRef.current.value = '';
        }
    };

    const handleDelete = async (id: string) => {
        try {
            const response = await fetch(`/api/workflows/${id}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                setWorkflows(prev => prev.filter(w => w.id !== id));
            }
        } catch (error) {
            console.error('Failed to delete workflow:', error);
        }
        setDeleteConfirm(null);
    };

    // Load more covers callback for infinite scroll
    const loadMoreCovers = useCallback(() => {
        setVisibleCoverCount(prev => Math.min(prev + COVERS_PER_PAGE, coverAssets.length));
    }, [coverAssets.length]);

    // Intersection Observer effect for infinite scroll
    useEffect(() => {
        if (!editingCoverFor || loadingAssets) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && visibleCoverCount < coverAssets.length) {
                    loadMoreCovers();
                }
            },
            { threshold: 0.1, rootMargin: '100px' }
        );

        if (loadMoreRef.current) {
            observer.observe(loadMoreRef.current);
        }

        return () => observer.disconnect();
    }, [editingCoverFor, loadingAssets, visibleCoverCount, coverAssets.length, loadMoreCovers]);

    const openCoverEditor = async (workflowId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingCoverFor(workflowId);
        setLoadingAssets(true);
        setVisibleCoverCount(COVERS_PER_PAGE); // Reset pagination

        try {
            const response = await fetch('/api/assets/images');
            if (response.ok) {
                const data = await response.json();
                setCoverAssets(data);
            }
        } catch (error) {
            console.error('Failed to fetch assets:', error);
        } finally {
            setLoadingAssets(false);
        }
    };

    const selectCover = async (assetUrl: string) => {
        if (!editingCoverFor) return;

        try {
            const response = await fetch(`/api/workflows/${editingCoverFor}/cover`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ coverUrl: `${assetUrl}` })
            });

            if (response.ok) {
                // Update local state
                setWorkflows(prev => prev.map(w =>
                    w.id === editingCoverFor
                        ? { ...w, coverUrl: `${assetUrl}` }
                        : w
                ));
            }
        } catch (error) {
            console.error('Failed to update cover:', error);
        }

        setEditingCoverFor(null);
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
        });
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Main Panel */}
            <div
                className={`fixed left-20 w-[700px] backdrop-blur-xl border rounded-2xl shadow-2xl z-40 flex flex-col overflow-hidden max-h-[500px] transition-colors duration-300 ${isDark ? 'bg-[#0a0a0a]/95 border-neutral-800' : 'bg-white/95 border-neutral-200'}`}
                style={{ top: panelY }}
            >
                {/* Header with Tabs */}
                <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                    <div className="flex items-center gap-6">
                        <button
                            onClick={() => setActiveTab('my')}
                            className={`font-medium pb-1 transition-colors ${activeTab === 'my' ? isDark ? 'text-white border-b-2 border-white' : 'text-neutral-900 border-b-2 border-neutral-900' : isDark ? 'text-neutral-500 hover:text-neutral-300' : 'text-neutral-400 hover:text-neutral-600'}`}
                        >
                            我的工作流
                        </button>
                        <button
                            onClick={() => setActiveTab('public')}
                            className={`font-medium pb-1 transition-colors ${activeTab === 'public' ? isDark ? 'text-white border-b-2 border-white' : 'text-neutral-900 border-b-2 border-neutral-900' : isDark ? 'text-neutral-500 hover:text-neutral-300' : 'text-neutral-400 hover:text-neutral-600'}`}
                        >
                            公共工作流
                        </button>
                    </div>
                    <div className="flex items-center gap-3">
                        <input
                            ref={importInputRef}
                            type="file"
                            accept="application/json,.json"
                            onChange={handleImportWorkflow}
                            className="hidden"
                        />
                        <button
                            onClick={() => importInputRef.current?.click()}
                            disabled={importing}
                            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${isDark ? 'bg-neutral-800 hover:bg-neutral-700 text-white border-neutral-700' : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-900 border-neutral-300'} disabled:opacity-50`}
                            title="导入工作流 JSON 文件到「我的工作流」"
                        >
                            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            导入
                        </button>
                        <button
                            onClick={onClose}
                            className={`transition-colors ${isDark ? 'text-neutral-500 hover:text-white' : 'text-neutral-400 hover:text-neutral-900'}`}
                        >
                            <Maximize2 size={18} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div
                    className="flex-1 overflow-y-auto p-4"
                    style={{
                        scrollbarWidth: 'thin',
                        scrollbarColor: isDark ? '#525252 #171717' : '#d4d4d4 #fafafa'
                    }}
                >
                    {loading && activeTab === 'my' ? (
                        <div className="flex items-center justify-center h-40">
                            <Loader2 className="animate-spin text-neutral-500" size={24} />
                        </div>
                    ) : activeTab === 'my' ? (
                        /* My Workflows Tab */
                        workflows.length === 0 ? (
                            <div className="flex items-center justify-center h-40 text-neutral-500">
                                未找到工作流
                            </div>
                        ) : (
                            <div className="grid grid-cols-5 gap-3">
                                {workflows.map(workflow => (
                                    <div
                                        key={workflow.id}
                                        onClick={() => onLoadWorkflow(workflow.id)}
                                        className={`rounded-lg overflow-hidden cursor-pointer transition-all group ${workflow.id === currentWorkflowId
                                            ? 'ring-2 ring-blue-500'
                                            : ''
                                            }`}
                                    >
                                        {/* Thumbnail */}
                                        <div className="aspect-video bg-gradient-to-br from-neutral-800 to-neutral-900 flex items-center justify-center relative overflow-hidden">
                                            {workflow.coverUrl ? (
                                                <img
                                                    src={workflow.coverUrl}
                                                    alt={workflow.title}
                                                    className="w-full h-full object-cover"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 flex items-center justify-center">
                                                    <FileText size={18} className="text-neutral-500" />
                                                </div>
                                            )}

                                            {/* Action buttons */}
                                            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                {/* Edit cover button */}
                                                <button
                                                    onClick={(e) => openCoverEditor(workflow.id, e)}
                                                    className="p-1 bg-black/50 hover:bg-blue-500 rounded-md transition-all"
                                                    title="编辑封面"
                                                >
                                                    <Pencil size={12} className="text-white" />
                                                </button>
                                                {/* Delete button */}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setDeleteConfirm(workflow.id);
                                                    }}
                                                    className="p-1 bg-black/50 hover:bg-red-500 rounded-md transition-all"
                                                    title="删除工作流"
                                                >
                                                    <Trash2 size={12} className="text-white" />
                                                </button>
                                            </div>
                                        </div>
                                        {/* Info */}
                                        <div className={`px-2 py-1.5 ${isDark ? 'bg-neutral-900/50' : 'bg-neutral-100/90'}`}>
                                            <h3 className={`font-medium text-xs truncate ${isDark ? 'text-white' : 'text-neutral-900'}`}>{workflow.title || '未命名'}</h3>
                                            <p className={`text-[10px] mt-0.5 ${isDark ? 'text-neutral-500' : 'text-neutral-600'}`}>
                                                {workflow.nodeCount} 个节点
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    ) : (
                        /* Public Workflows Tab */
                        publicWorkflows.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-40 text-neutral-500 gap-2">
                                <FileText size={32} className="opacity-50" />
                                <p>暂无公共工作流</p>
                                <p className="text-xs text-neutral-600">将工作流 JSON 添加到 public/workflows/</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-5 gap-3">
                                {publicWorkflows.map(workflow => (
                                    <div
                                        key={workflow.id}
                                        onClick={() => onLoadWorkflow(`public:${workflow.id}`)}
                                        className="rounded-lg overflow-hidden cursor-pointer transition-all group"
                                    >
                                        {/* Thumbnail */}
                                        <div className="aspect-video bg-gradient-to-br from-green-800/30 to-emerald-900/30 flex items-center justify-center relative overflow-hidden">
                                            {workflow.coverUrl ? (
                                                <img
                                                    src={workflow.coverUrl}
                                                    alt={workflow.title}
                                                    className="w-full h-full object-cover"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-green-500/20 to-emerald-600/20 flex items-center justify-center">
                                                    <FileText size={18} className="text-neutral-500" />
                                                </div>
                                            )}
                                            {/* Public badge */}
                                            <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-green-600/80 rounded text-[10px] font-medium text-white">
                                                公共
                                            </div>
                                        </div>
                                        {/* Info */}
                                        <div className={`px-2 py-1.5 ${isDark ? 'bg-neutral-900/50' : 'bg-neutral-100/90'}`}>
                                            <h3 className={`font-medium text-xs truncate ${isDark ? 'text-white' : 'text-neutral-900'}`}>{workflow.title || '未命名'}</h3>
                                            <p className={`text-[10px] mt-0.5 truncate ${isDark ? 'text-neutral-500' : 'text-neutral-600'}`}>
                                                {workflow.description || `${workflow.nodeCount} 个节点`}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    )}
                </div>
            </div>

            {/* Delete Confirmation Modal */}
            {deleteConfirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-[#1a1a1a] border border-neutral-700 rounded-2xl p-6 w-[340px] shadow-2xl">
                        <h3 className="text-lg font-semibold text-white mb-2">删除工作流</h3>
                        <p className="text-neutral-400 text-sm mb-6">
                            确定要删除此工作流吗？此操作无法撤销。
                        </p>
                        <div className="flex gap-3 justify-end">
                            <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-sm transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => handleDelete(deleteConfirm)}
                                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm transition-colors"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Cover Selection Modal */}
            {editingCoverFor && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-[#1a1a1a] border border-neutral-700 rounded-2xl p-6 w-[500px] max-h-[500px] shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold text-white">选择封面图像</h3>
                            <button
                                onClick={() => setEditingCoverFor(null)}
                                className="p-1.5 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {loadingAssets ? (
                            <div className="flex items-center justify-center h-40">
                                <Loader2 className="animate-spin text-neutral-500" size={24} />
                            </div>
                        ) : coverAssets.length === 0 ? (
                            <div className="flex items-center justify-center h-40 text-neutral-500">
                                暂无可用图像。请先生成一些图像！
                            </div>
                        ) : (
                            <div className="grid grid-cols-3 gap-3 overflow-y-auto flex-1">
                                {coverAssets.slice(0, visibleCoverCount).map(asset => (
                                    <button
                                        key={asset.id}
                                        onClick={() => selectCover(asset.url)}
                                        className="h-32 w-full rounded-lg overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all relative group bg-neutral-900"
                                    >
                                        <LazyImage
                                            src={`${asset.url}`}
                                            alt="封面选项"
                                            className="w-full h-full"
                                            placeholderClassName="rounded-lg"
                                            rootMargin="100px"
                                        />
                                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                                            <Check size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </div>
                                    </button>
                                ))}

                                {/* Load more sentinel - triggers infinite scroll */}
                                {visibleCoverCount < coverAssets.length && (
                                    <div
                                        ref={loadMoreRef}
                                        className="col-span-3 flex items-center justify-center py-4"
                                    >
                                        <Loader2 className="animate-spin text-neutral-500" size={20} />
                                        <span className="ml-2 text-neutral-500 text-sm">加载更多...</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};
