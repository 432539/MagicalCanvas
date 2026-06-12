import React, { useState, useRef, useEffect } from 'react';
import {
  LayoutGrid,
  Image as ImageIcon,
  MessageSquare,
  History,
  Sparkles,
  MoreHorizontal,
  Plus,
  Film,
  Scissors,
  Wand2
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface ToolbarProps {
  onAddClick?: (e: React.MouseEvent) => void;
  onWorkflowsClick?: (e: React.MouseEvent) => void;
  onHistoryClick?: (e: React.MouseEvent) => void;
  onAssetsClick?: (e: React.MouseEvent) => void;
  onStoryboardClick?: (e: React.MouseEvent) => void;
  onStoryWorkflowClick?: (e: React.MouseEvent) => void;
  onVideoStudioClick?: (e: React.MouseEvent) => void;
  onToolsOpen?: () => void; // Called when tools dropdown opens to close other panels
  canvasTheme?: 'dark' | 'light';
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Toolbar: React.FC<ToolbarProps> = ({
  onAddClick,
  onWorkflowsClick,
  onHistoryClick,
  onAssetsClick,
  onStoryboardClick,
  onStoryWorkflowClick,
  onVideoStudioClick,
  onToolsOpen,
  canvasTheme = 'dark'
}) => {
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setIsToolsOpen(false);
      }
    };

    if (isToolsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isToolsOpen]);

  const handleToolClick = (callback?: (e: React.MouseEvent) => void) => (e: React.MouseEvent) => {
    setIsToolsOpen(false);
    callback?.(e);
  };

  // Theme-aware styles
  const isDark = canvasTheme === 'dark';

  return (
    <div className={`fixed left-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-2 p-1 rounded-full shadow-2xl z-50 transition-colors duration-300 ${isDark ? 'bg-[#1a1a1a] border border-neutral-800' : 'bg-white/90 backdrop-blur-sm border border-neutral-200'
      }`}>
      <button
        className={`w-10 h-10 rounded-full flex items-center justify-center hover:scale-110 transition-all duration-200 mb-2 ${isDark ? 'bg-white text-black hover:bg-neutral-200' : 'bg-neutral-900 text-white hover:bg-neutral-700'
          }`}
        onClick={onAddClick}
      >
        <Plus size={20} />
      </button>

      <div className="flex flex-col gap-4 py-2 px-1">
        <button
          className={`hover:scale-125 transition-all duration-200 ${isDark ? 'text-neutral-400 hover:text-white' : 'text-neutral-500 hover:text-neutral-900'
            }`}
          onClick={onWorkflowsClick}
          title="我的工作流"
        >
          <LayoutGrid size={20} />
        </button>
        <button
          className={`hover:scale-125 transition-all duration-200 ${isDark ? 'text-neutral-400 hover:text-white' : 'text-neutral-500 hover:text-neutral-900'
            }`}
          title="素材"
          onClick={onAssetsClick}
        >
          <ImageIcon size={20} />
        </button>
        <button
          className={`hover:scale-125 transition-all duration-200 ${isDark ? 'text-neutral-400 hover:text-white' : 'text-neutral-500 hover:text-neutral-900'
            }`}
          onClick={onHistoryClick}
          title="历史"
        >
          <History size={20} />
        </button>

        {/* Tools Dropdown */}
        <div className="relative" ref={toolsRef}>
          <button
            className={`hover:scale-125 transition-all duration-200 ${isDark
              ? `text-neutral-400 hover:text-white ${isToolsOpen ? 'text-white' : ''}`
              : `text-neutral-500 hover:text-neutral-900 ${isToolsOpen ? 'text-neutral-900' : ''}`
              }`}
            onClick={() => {
              if (!isToolsOpen) {
                onToolsOpen?.(); // Close other panels when opening tools
              }
              setIsToolsOpen(!isToolsOpen);
            }}
            title="AI"
          >
            <Sparkles size={20} />
          </button>

          {/* Dropdown Menu */}
          {isToolsOpen && (
            <div className={`absolute left-10 top-0 rounded-lg shadow-2xl py-2 min-w-[240px] z-50 ${isDark ? 'bg-[#1a1a1a] border border-neutral-700' : 'bg-white border border-neutral-200'
              }`}>
              {/* Story Workflow (一键创建工作流) */}
              <button
                onClick={handleToolClick(onStoryWorkflowClick)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors group ${isDark ? 'hover:bg-neutral-800' : 'hover:bg-neutral-100'
                  }`}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-cyan-500/25 to-violet-500/25">
                  <Wand2 size={16} className="text-cyan-400" />
                </div>
                <div className="text-left">
                  <p className={`text-sm ${isDark ? 'text-neutral-200 group-hover:text-white' : 'text-neutral-700 group-hover:text-neutral-900'}`}>一键创作</p>
                  <p className={`text-xs ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>小说/剧本 → 完整工作流</p>
                </div>
              </button>

              {/* Storyboard Generator */}
              <button
                onClick={handleToolClick(onStoryboardClick)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors group ${isDark ? 'hover:bg-neutral-800' : 'hover:bg-neutral-100'
                  }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDark ? 'bg-neutral-800' : 'bg-neutral-200'}`}>
                  <Film size={16} className={isDark ? 'text-white' : 'text-neutral-700'} />
                </div>
                <div className="text-left">
                  <p className={`text-sm ${isDark ? 'text-neutral-200 group-hover:text-white' : 'text-neutral-700 group-hover:text-neutral-900'}`}>分镜生成器</p>
                  <p className={`text-xs ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>用 AI 创建场景</p>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Video Studio (视频剪辑) */}
        <button
          className={`hover:scale-125 transition-all duration-200 ${isDark ? 'text-neutral-400 hover:text-white' : 'text-neutral-500 hover:text-neutral-900'
            }`}
          onClick={onVideoStudioClick}
          title="视频剪辑"
        >
          <Scissors size={20} />
        </button>
      </div>

      <div className={`w-8 h-[1px] my-1 ${isDark ? 'bg-neutral-800' : 'bg-neutral-200'}`}></div>

      {/* 开源仓库链接（EXE 中经 setWindowOpenHandler 在系统浏览器打开） */}
      <a
        href="https://github.com/28998306/MagicalCanvas"
        target="_blank"
        rel="noopener noreferrer"
        title="开源地址：github.com/28998306/MagicalCanvas"
        className={`w-8 h-8 rounded-full mb-2 flex items-center justify-center hover:scale-110 transition-all duration-200 ${isDark
          ? 'border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500'
          : 'border border-neutral-300 text-neutral-500 hover:text-neutral-900 hover:border-neutral-400'
          }`}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
    </div>
  );
};
