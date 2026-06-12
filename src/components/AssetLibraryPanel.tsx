import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2, Upload, Loader2, Plus } from 'lucide-react';
import { showAppAlert } from './ui/AppDialog';

interface LibraryAsset {
    id: string;
    name: string;
    category: string;
    url: string;
    type: 'image' | 'video';
}

interface AssetLibraryPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectAsset: (url: string, type: 'image' | 'video') => void;
    panelY?: number;
    variant?: 'panel' | 'modal';
    canvasTheme?: 'dark' | 'light';
}

const BUILTIN_CATEGORIES = [
    'Character',
    'Scene',
    'Item',
    'Style',
    'Sound Effect',
    'Others'
];

export const AssetLibraryPanel: React.FC<AssetLibraryPanelProps> = ({
    isOpen,
    onClose,
    onSelectAsset,
    panelY = 100,
    variant = 'panel',
    canvasTheme = 'dark'
}) => {
    const [selectedCategory, setSelectedCategory] = useState('All');
    const [assets, setAssets] = useState<LibraryAsset[]>([]);
    const [customCategories, setCustomCategories] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            fetchLibrary();
            fetchCategories();
        }
    }, [isOpen]);

    const fetchLibrary = async () => {
        setLoading(true);
        try {
            const res = await fetch('http://localhost:3501/api/library'); // Adjust port if needed, relative path preferred in helper
            if (res.ok) {
                setAssets(await res.json());
            }
        } catch (error) {
            console.error("Failed to load library:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchCategories = async () => {
        try {
            const res = await fetch('http://localhost:3501/api/library/categories');
            if (res.ok) {
                const data = await res.json();
                setCustomCategories(Array.isArray(data.custom) ? data.custom : []);
            }
        } catch (error) {
            console.error('Failed to load categories:', error);
        }
    };

    const handleAddCategory = async (name: string) => {
        const res = await fetch('http://localhost:3501/api/library/categories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
            showAppAlert(data.error || '添加分类失败');
            return;
        }
        setCustomCategories(data.custom);
        setSelectedCategory(name);
    };

    const handleDeleteCategory = async (name: string) => {
        const res = await fetch(`http://localhost:3501/api/library/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
            showAppAlert(data.error || '删除分类失败');
            return;
        }
        setCustomCategories(data.custom);
        if (selectedCategory === name) setSelectedCategory('All');
        await fetchLibrary(); // 该分类下素材已归入 Others
    };

    // 导入本地视频/图片到素材库（归入当前分类，「All」时归入 Others）
    const importInputRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);

    const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        setImporting(true);
        let failed = 0;
        const category = selectedCategory === 'All' ? 'Others' : selectedCategory;
        for (const file of files) {
            try {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result as string);
                    fr.onerror = reject;
                    fr.readAsDataURL(file);
                });
                const res = await fetch('http://localhost:3501/api/library', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sourceUrl: dataUrl,
                        name: file.name.replace(/\.[^.]+$/, ''),
                        category,
                    }),
                });
                if (!res.ok) throw new Error();
            } catch (_) {
                failed++;
            }
        }
        setImporting(false);
        if (importInputRef.current) importInputRef.current.value = '';
        if (failed > 0) showAppAlert(`${failed} 个文件导入失败`);
        await fetchLibrary();
    };

    const handleDeleteAsset = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent selection
        // Confirmation is now handled in the UI before this is called

        try {
            const res = await fetch(`http://localhost:3501/api/library/${id}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                setAssets(prev => prev.filter(a => a.id !== id));
            } else {
                console.error("Failed to delete asset");
            }
        } catch (error) {
            console.error("Delete error:", error);
        }
    };

    if (!isOpen) return null;

    // Theme helper
    const isDark = canvasTheme === 'dark';

    if (variant === 'modal') {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                <div
                    className={`flex flex-col w-[800px] h-[600px] border rounded-2xl shadow-2xl overflow-hidden transition-colors duration-300 ${isDark ? 'bg-[#0a0a0a] border-neutral-800' : 'bg-white border-neutral-200'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                        <h2 className={`text-lg font-medium pl-2 ${isDark ? 'text-white' : 'text-neutral-900'}`}>素材库</h2>
                        <button onClick={onClose} className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}>
                            <X size={20} />
                        </button>
                    </div>
                    {/* Reuse internal content logic */}
                    <input ref={importInputRef} type="file" multiple accept="image/*,video/*" onChange={handleImportFiles} className="hidden" />
                    <AssetLibraryContent
                        selectedCategory={selectedCategory}
                        setSelectedCategory={setSelectedCategory}
                        assets={assets}
                        loading={loading}
                        onSelectAsset={onSelectAsset}
                        onDeleteAsset={handleDeleteAsset}
                        variant={variant}
                        canvasTheme={canvasTheme}
                        importing={importing}
                        onImportClick={() => importInputRef.current?.click()}
                        customCategories={customCategories}
                        onAddCategory={handleAddCategory}
                        onDeleteCategory={handleDeleteCategory}
                    />
                </div>
                {/* Click outside to close */}
                <div className="absolute inset-0 -z-10" onClick={onClose} />
            </div>
        );
    }

    return (
        <div
            className={`fixed left-20 z-40 w-[700px] backdrop-blur-xl border rounded-2xl shadow-2xl flex flex-col max-h-[500px] overflow-hidden animate-in slide-in-from-left-4 duration-200 transition-colors ${isDark ? 'bg-[#0a0a0a]/95 border-neutral-800' : 'bg-white/95 border-neutral-200'}`}
            style={{ top: Math.min(window.innerHeight - 510, Math.max(20, panelY)) }}
        >
            <input ref={importInputRef} type="file" multiple accept="image/*,video/*" onChange={handleImportFiles} className="hidden" />
            <AssetLibraryContent
                selectedCategory={selectedCategory}
                setSelectedCategory={setSelectedCategory}
                assets={assets}
                loading={loading}
                onSelectAsset={onSelectAsset}
                onDeleteAsset={handleDeleteAsset}
                variant={variant}
                canvasTheme={canvasTheme}
                importing={importing}
                onImportClick={() => importInputRef.current?.click()}
                customCategories={customCategories}
                onAddCategory={handleAddCategory}
                onDeleteCategory={handleDeleteCategory}
            />
        </div>
    );
};

// Extracted Internal Component for reuse
const AssetLibraryContent = ({
    selectedCategory, setSelectedCategory,
    assets, loading, onSelectAsset, onDeleteAsset, variant, canvasTheme = 'dark',
    importing, onImportClick,
    customCategories = [], onAddCategory, onDeleteCategory
}: any) => {
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [addingCategory, setAddingCategory] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const isDark = canvasTheme === 'dark';

    const allCategories: string[] = ['All', ...BUILTIN_CATEGORIES, ...customCategories];

    const submitNewCategory = () => {
        const name = newCategoryName.trim();
        setAddingCategory(false);
        setNewCategoryName('');
        if (name) onAddCategory?.(name);
    };

    const filteredAssets = assets.filter((asset: any) =>
        selectedCategory === 'All' || asset.category === selectedCategory
    );

    const handleDeleteClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeleteConfirmId(id);
    };

    const handleConfirmDelete = (e: React.MouseEvent, id: string) => {
        onDeleteAsset(id, e);
        setDeleteConfirmId(null);
    };

    const handleCancelDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        setDeleteConfirmId(null);
    };

    return (
        <>

            <div className="p-4 flex flex-col gap-4 h-full overflow-hidden">
                {/* Filters + 导入 */}
                <div className="flex items-center gap-2 shrink-0">
                    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide flex-1 min-w-0 items-center">
                        {allCategories.map(cat => {
                            const isCustom = customCategories.includes(cat);
                            return (
                                <div key={cat} className="relative group/cat shrink-0">
                                    <button
                                        onClick={() => setSelectedCategory(cat)}
                                        className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${selectedCategory === cat
                                            ? isDark ? 'bg-neutral-100 text-black border-white' : 'bg-neutral-900 text-white border-neutral-900'
                                            : isDark ? 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:border-neutral-600' : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-300'
                                            }`}
                                    >
                                        {cat}
                                    </button>
                                    {isCustom && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onDeleteCategory?.(cat); }}
                                            className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white items-center justify-center hidden group-hover/cat:flex hover:bg-red-600"
                                            title="删除该分类（素材将归入 Others）"
                                        >
                                            <X size={9} />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {addingCategory ? (
                            <input
                                autoFocus
                                value={newCategoryName}
                                onChange={e => setNewCategoryName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitNewCategory(); if (e.key === 'Escape') { setAddingCategory(false); setNewCategoryName(''); } }}
                                onBlur={submitNewCategory}
                                placeholder="分类名称"
                                className={`w-24 shrink-0 px-3 py-1.5 rounded-full text-xs border outline-none ${isDark ? 'bg-neutral-900 text-white border-neutral-600' : 'bg-white text-neutral-900 border-neutral-400'}`}
                            />
                        ) : (
                            <button
                                onClick={() => setAddingCategory(true)}
                                className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs border border-dashed transition-colors ${isDark ? 'text-neutral-500 border-neutral-700 hover:text-white hover:border-neutral-500' : 'text-neutral-400 border-neutral-300 hover:text-neutral-700 hover:border-neutral-400'}`}
                                title="新建自定义分类"
                            >
                                <Plus size={12} /> 分类
                            </button>
                        )}
                    </div>
                    <button
                        onClick={onImportClick}
                        disabled={importing}
                        className={`flex items-center gap-1.5 px-3 py-1.5 mb-2 rounded-full text-xs font-medium whitespace-nowrap border transition-colors disabled:opacity-50 ${isDark ? 'bg-neutral-800 hover:bg-neutral-700 text-white border-neutral-700' : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-900 border-neutral-300'}`}
                        title="导入本地视频/图片到当前分类（可多选）"
                    >
                        {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                        导入
                    </button>
                </div>

                {/* Content */}
                <div
                    className="flex-1 overflow-y-auto pr-2 grid gap-3 pb-4 content-start grid-cols-4"
                    style={{
                        scrollbarWidth: 'thin',
                        scrollbarColor: isDark ? '#525252 #171717' : '#d4d4d4 #fafafa'
                    }}
                >
                    {loading ? (
                        <div className="col-span-full text-center py-10 text-neutral-500">加载中...</div>
                    ) : filteredAssets.length === 0 ? (
                        <div className="col-span-full text-center py-10 text-neutral-500 text-sm">
                            此分类下暂无素材。
                        </div>
                    ) : (
                        filteredAssets.map((asset: any) => (
                            <div
                                key={asset.id}
                                className="group relative aspect-square bg-neutral-900 rounded-lg overflow-hidden border border-neutral-800 hover:border-neutral-600 cursor-pointer"
                                onClick={() => onSelectAsset(asset.url, asset.type)}
                            >
                                <img
                                    src={asset.url}
                                    alt={asset.name}
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                        const target = e.target as HTMLImageElement;
                                        target.onerror = null; // Prevent infinite loop
                                        target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzIiB5PSIzIiB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHJ4PSIyIiByeT0iMiI+PC9yZWN0PjxjaXJjbGUgY3g9IjguNSIgY3k9IjguNSIgcj0iMS41Ij48L2NpcmNsZT48cG9seWxpbmUgcG9pbnRzPSIyMSAxNSAxNiAxMCA1IDIxIj48LcG9lyxpbmU+PC9zdmc+';
                                        target.classList.add('p-8', 'opacity-50');
                                    }}
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 pointer-events-none">
                                    <span className="text-white text-xs font-medium truncate">{asset.name}</span>
                                </div>

                                {/* Delete Button or Confirmation */}
                                {deleteConfirmId === asset.id ? (
                                    <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2 z-20 animate-in fade-in duration-200" onClick={(e) => e.stopPropagation()}>
                                        <span className="text-white text-xs font-medium">删除？</span>
                                        <div className="flex gap-2">
                                            <button
                                                className="px-2 py-1 bg-red-500 hover:bg-red-600 text-white text-xs rounded transition-colors"
                                                onClick={(e) => handleConfirmDelete(e, asset.id)}
                                            >
                                                是
                                            </button>
                                            <button
                                                className="px-2 py-1 bg-neutral-700 hover:bg-neutral-600 text-white text-xs rounded transition-colors"
                                                onClick={handleCancelDelete}
                                            >
                                                否
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        className="absolute top-1 right-1 p-1.5 bg-black/60 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/80 z-10"
                                        onClick={(e) => handleDeleteClick(e, asset.id)}
                                        title="删除素材"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </>
    );
};
