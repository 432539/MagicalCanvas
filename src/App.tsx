/**
 * App.tsx
 * 
 * Main application component for TwitCanva.
 * Orchestrates canvas, nodes, connections, and user interactions.
 * Uses custom hooks for state management and logic separation.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Toolbar } from './components/Toolbar';
import { TopBar } from './components/TopBar';
import { CanvasNode } from './components/canvas/CanvasNode';
import { ConnectionsLayer, getNodeWidth, getNodeHeight } from './components/canvas/ConnectionsLayer';
import { LayoutGrid, RotateCcw } from 'lucide-react';
import { ContextMenu } from './components/ContextMenu';
import { ContextMenuState, NodeData, NodeStatus, NodeType } from './types';
import { generateImage, generateVideo } from './services/generationService';
import { useCanvasNavigation } from './hooks/useCanvasNavigation';
import { useNodeManagement } from './hooks/useNodeManagement';
import { useConnectionDragging } from './hooks/useConnectionDragging';
import { useNodeDragging } from './hooks/useNodeDragging';
import { useGeneration } from './hooks/useGeneration';
import { useSelectionBox } from './hooks/useSelectionBox';
import { useGroupManagement } from './hooks/useGroupManagement';
import { useHistory } from './hooks/useHistory';
import { useCanvasTitle } from './hooks/useCanvasTitle';
import { useWorkflow } from './hooks/useWorkflow';
import { useImageEditor } from './hooks/useImageEditor';
import { useVideoEditor } from './hooks/useVideoEditor';
import { usePanelState } from './hooks/usePanelState';
import { useAssetHandlers } from './hooks/useAssetHandlers';
import { useTextNodeHandlers } from './hooks/useTextNodeHandlers';
import { useImageNodeHandlers } from './hooks/useImageNodeHandlers';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useContextMenuHandlers } from './hooks/useContextMenuHandlers';
import { useAutoSave } from './hooks/useAutoSave';
import { useGenerationRecovery } from './hooks/useGenerationRecovery';
import { useVideoFrameExtraction } from './hooks/useVideoFrameExtraction';
import { extractVideoLastFrame } from './utils/videoHelpers';
import { SelectionBoundingBox } from './components/canvas/SelectionBoundingBox';
import { WorkflowPanel } from './components/WorkflowPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { ChatPanel, ChatBubble } from './components/ChatPanel';
import { ImageEditorModal } from './components/modals/ImageEditorModal';
import { VideoEditorModal } from './components/modals/VideoEditorModal';
import { ExpandedMediaModal } from './components/modals/ExpandedMediaModal';
import { CreateAssetModal } from './components/modals/CreateAssetModal';
import { AssetLibraryPanel } from './components/AssetLibraryPanel';
import { useStoryboardGenerator } from './hooks/useStoryboardGenerator';
import { StoryboardGeneratorModal } from './components/modals/StoryboardGeneratorModal';
import { StoryboardVideoModal } from './components/modals/StoryboardVideoModal';
import { StoryWorkflowModal, StoryWorkflowResult } from './components/modals/StoryWorkflowModal';
import { VideoStudioPage } from './components/videoStudio/VideoStudioPage';
import { AppDialogHost, showAppAlert } from './components/ui/AppDialog';
import { DesktopTitleBar } from './components/ui/DesktopTitleBar';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

// Helper to convert URL/Blob to Base64
const urlToBase64 = async (url: string): Promise<string> => {
  if (url.startsWith('data:image')) return url;

  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error("Error converting URL to base64:", e);
    return "";
  }
};

export default function App() {
  // ============================================================================
  // STATE
  // ============================================================================

  const [hasApiKey] = useState(true); // Backend handles API key
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    type: 'global'
  });

  const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark');

  // Panel state management (history, chat, asset library, expand)
  const {
    isHistoryPanelOpen,
    historyPanelY,
    handleHistoryClick: panelHistoryClick,
    closeHistoryPanel,
    expandedImageUrl,
    handleExpandImage,
    handleCloseExpand,
    isChatOpen,
    toggleChat,
    closeChat,
    isAssetLibraryOpen,
    assetLibraryY,
    assetLibraryVariant,
    handleAssetsClick: panelAssetsClick,
    closeAssetLibrary,
    openAssetLibraryModal,
    isDraggingNodeToChat,
    handleNodeDragStart,
    handleNodeDragEnd
  } = usePanelState();

  const [canvasHoveredNodeId, setCanvasHoveredNodeId] = useState<string | null>(null);


  // Canvas title state (via hook)
  const {
    canvasTitle,
    setCanvasTitle,
    isEditingTitle,
    setIsEditingTitle,
    editingTitleValue,
    setEditingTitleValue,
    canvasTitleInputRef
  } = useCanvasTitle();

  const {
    viewport,
    setViewport,
    canvasRef,
    handleWheel: baseHandleWheel,
    handleSliderZoom
  } = useCanvasNavigation();

  // Wrap handleWheel to pass hovered node for zoom-to-center
  const handleWheel = (e: React.WheelEvent) => {
    const hoveredNode = canvasHoveredNodeId ? nodes.find(n => n.id === canvasHoveredNodeId) : undefined;
    baseHandleWheel(e, hoveredNode);
  };

  const {
    nodes,
    setNodes,
    selectedNodeIds,
    setSelectedNodeIds,
    addNode,
    updateNode,
    deleteNode,
    deleteNodes,
    clearSelection,
    handleSelectTypeFromMenu
  } = useNodeManagement();

  const {
    isDraggingConnection,
    connectionStart,
    tempConnectionEnd,
    hoveredNodeId: connectionHoveredNodeId,
    selectedConnection,
    setSelectedConnection,
    handleConnectorPointerDown,
    updateConnectionDrag,
    completeConnectionDrag,
    handleEdgeClick,
    deleteSelectedConnection
  } = useConnectionDragging();

  const {
    handleNodePointerDown,
    updateNodeDrag,
    endNodeDrag,
    startPanning,
    updatePanning,
    endPanning,
    isDragging,
    releasePointerCapture
  } = useNodeDragging();

  const {
    selectionBox,
    isSelecting,
    startSelection,
    updateSelection,
    endSelection,
    clearSelectionBox
  } = useSelectionBox();

  const {
    groups,
    setGroups, // For workflow loading
    groupNodes,
    ungroupNodes,
    cleanupInvalidGroups,
    getCommonGroup,
    sortGroupNodes,
    renameGroup
  } = useGroupManagement();

  // History for undo/redo
  const {
    present: historyState,
    undo,
    redo,
    pushHistory,
    canUndo,
    canRedo
  } = useHistory({ nodes, groups }, 50);

  // Workflow management
  const {
    workflowId,
    isWorkflowPanelOpen,
    workflowPanelY,
    handleSaveWorkflow,
    handleLoadWorkflow,
    handleWorkflowsClick,
    closeWorkflowPanel,
    resetWorkflowId
  } = useWorkflow({
    nodes,
    groups,
    viewport,
    canvasTitle,
    setNodes,
    setGroups,
    setSelectedNodeIds,
    setCanvasTitle,
    setEditingTitleValue,
    onPanelOpen: () => {
      closeHistoryPanel();
      closeAssetLibrary();
    }
  });

  // Simple dirty flag for unsaved changes tracking
  const [isDirty, setIsDirty] = React.useState(false);
  const hasUnsavedChanges = isDirty && nodes.length > 0;

  // Mark as dirty when nodes or title change
  const isInitialMount = React.useRef(true);
  const lastLoadingCountRef = React.useRef(0);
  const ignoreNextChange = React.useRef(false);

  React.useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (ignoreNextChange.current) {
      ignoreNextChange.current = false;
      return;
    }

    setIsDirty(true);

    // Trigger immediate save if any node JUST entered LOADING state
    const currentLoadingCount = nodes.filter(n => n.status === NodeStatus.LOADING).length;
    if (currentLoadingCount > lastLoadingCountRef.current) {
      console.log('[App] New loading node detected, triggering immediate save for recovery protection');
      handleSaveWithTracking();
    }
    lastLoadingCountRef.current = currentLoadingCount;
  }, [nodes, canvasTitle]);

  // Update saved state after workflow save
  const handleSaveWithTracking = async () => {
    await handleSaveWorkflow();
    setIsDirty(false);
  };

  // Load workflow and update tracking
  const handleLoadWithTracking = async (id: string) => {
    ignoreNextChange.current = true;
    await handleLoadWorkflow(id);
    setIsDirty(false);
  };

  const { handleGenerate } = useGeneration({
    nodes,
    updateNode
  });

  // Keep a ref to handleGenerate so setTimeout callbacks can access the latest version
  const handleGenerateRef = React.useRef(handleGenerate);
  React.useEffect(() => {
    handleGenerateRef.current = handleGenerate;
  }, [handleGenerate]);

  // Create new canvas
  const handleNewCanvas = () => {
    ignoreNextChange.current = true;
    setNodes([]);
    setGroups([]); // Reset groups for new canvas
    setSelectedNodeIds([]);
    setCanvasTitle('未命名画布');
    setEditingTitleValue('未命名画布');
    resetWorkflowId(); // Important: ensures new workflow gets a new ID
    setIsDirty(false);
  };

  // Image editor modal
  const {
    editorModal,
    handleOpenImageEditor,
    handleCloseImageEditor,
    handleUpload
  } = useImageEditor({ nodes, updateNode });

  // Video editor modal
  const {
    videoEditorModal,
    handleOpenVideoEditor,
    handleCloseVideoEditor,
    handleExportTrimmedVideo
  } = useVideoEditor({ nodes, updateNode });

  /**
   * Routes editor open to the correct handler based on node type
   */
  const handleOpenEditor = React.useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    if (node.type === NodeType.VIDEO_EDITOR) {
      handleOpenVideoEditor(nodeId);
    } else {
      handleOpenImageEditor(nodeId);
    }
  }, [nodes, handleOpenVideoEditor, handleOpenImageEditor]);

  // Text node handlers
  const {
    handleWriteContent,
    handleTextToVideo,
    handleTextToImage
  } = useTextNodeHandlers({ nodes, updateNode, setNodes, setSelectedNodeIds });

  // Image node handlers
  const {
    handleImageToImage,
    handleImageToVideo,
    handleChangeAngleGenerate
  } = useImageNodeHandlers({ nodes, setNodes, setSelectedNodeIds, onGenerateNode: handleGenerate });

  // Asset handlers (create asset modal)
  const {
    isCreateAssetModalOpen,
    setIsCreateAssetModalOpen,
    nodeToSnapshot,
    handleOpenCreateAsset,
    handleSaveAssetToLibrary,
    handleContextUpload
  } = useAssetHandlers({ nodes, viewport, contextMenu, setNodes });

  // Keyboard shortcuts (copy/paste/delete/undo/redo)
  const {
    handleCopy,
    handlePaste,
    handleDuplicate
  } = useKeyboardShortcuts({
    nodes,
    selectedNodeIds,
    selectedConnection,
    setNodes,
    setSelectedNodeIds,
    setContextMenu,
    deleteNodes,
    deleteSelectedConnection,
    clearSelection,
    clearSelectionBox,
    undo,
    redo
  });

  // Auto-Save Management
  const { lastSaveTime: lastAutoSaveTime } = useAutoSave({
    isDirty,
    nodes,
    onSave: handleSaveWithTracking,
    interval: 60000 // Save every 60 seconds
  });

  // Generation Recovery Management
  useGenerationRecovery({
    nodes,
    updateNode
  });

  // Video Frame Extraction (auto-extract lastFrame for videos missing thumbnails)
  useVideoFrameExtraction({
    nodes,
    updateNode
  });

  // Video Studio (视频剪辑)
  const [isVideoStudioOpen, setIsVideoStudioOpen] = useState(false);

  // Storyboard Generator Tool
  const handleCreateStoryboardNodes = React.useCallback((
    newNodeData: Partial<NodeData>[],
    groupInfo?: { groupId: string; groupLabel: string }
  ) => {
    console.log('[Storyboard] handleCreateStoryboardNodes called with', newNodeData.length, 'nodes, groupInfo:', !!groupInfo);
    const newNodes: NodeData[] = newNodeData.map(data => ({
      id: data.id || crypto.randomUUID(),
      type: data.type || NodeType.IMAGE,
      x: data.x || 0,
      y: data.y || 0,
      prompt: data.prompt || '',
      status: data.status || NodeStatus.IDLE,
      model: data.model || 'gpt-image-1.5',
      imageModel: data.imageModel,
      aspectRatio: data.aspectRatio || '16:9',
      resolution: data.resolution || '1K',
      title: data.title,
      parentIds: data.parentIds || [],
      groupId: data.groupId,
      characterReferenceUrls: data.characterReferenceUrls
    }));

    setNodes(prev => [...prev, ...newNodes]);

    // Auto-group the storyboard nodes
    if (groupInfo && newNodes.length > 0) {
      const newGroup = {
        id: groupInfo.groupId,
        nodeIds: newNodes.map(n => n.id),
        label: groupInfo.groupLabel,
        // Save story context if available to help AI understand the full narrative later
        storyContext: (groupInfo as any).storyContext
      };
      setGroups(prev => [...prev, newGroup]);
    }

    if (newNodes.length > 0) {
      setSelectedNodeIds(newNodes.map(n => n.id));
    }

    // Auto-trigger generation for each storyboard node with a small delay
    // to ensure state is updated before generation starts
    if (groupInfo) {
      setTimeout(() => {
        console.log('[Storyboard] Auto-triggering generation for', newNodes.length, 'nodes');
        newNodes.forEach((node, index) => {
          // Stagger generation calls slightly to avoid overwhelming the API
          setTimeout(() => {
            console.log(`[Storyboard] Starting generation for node ${index + 1}:`, node.id);
            // Use ref to get the latest handleGenerate function
            handleGenerateRef.current(node.id);
          }, index * 500); // 500ms delay between each node
        });
      }, 100); // Initial delay to let state settle
    }
  }, [setNodes, setSelectedNodeIds, setGroups]);

  const storyboardGenerator = useStoryboardGenerator({
    onCreateNodes: handleCreateStoryboardNodes,
    viewport
  });

  // ============================================================================
  // 一键创建工作流（小说/剧本 → 资产 + 分镜 + 视频节点）
  // ============================================================================
  const [isStoryWorkflowOpen, setIsStoryWorkflowOpen] = useState(false);

  // 自动生图队列：先生成资产图，全部完成后再生成分镜图（分镜依赖资产图作图生图参考）。
  // 用并发上限的队列驱动（而非一次性全部触发）：浏览器对同一域名最多 6 个并发连接，
  // 十几个生图请求同时挂起会饿死图片预览请求，导致节点裂图。
  const storyAutoGenRef = useRef<{ assetIds: string[]; shotIds: string[]; phase: 'assets' | 'shots' | 'done'; launched: Set<string> } | null>(null);

  useEffect(() => {
    const st = storyAutoGenRef.current;
    if (!st || st.phase === 'done') return;
    const MAX_CONCURRENT = 3;
    const isDone = (n: NodeData) => n.status === NodeStatus.SUCCESS || n.status === NodeStatus.ERROR;

    const ids = st.phase === 'assets' ? st.assetIds : st.shotIds;
    const tracked = nodes.filter(n => ids.includes(n.id));
    // 节点尚未挂载到画布（创建瞬间的竞态），等下一次 nodes 变化再调度
    if (ids.length > 0 && tracked.length === 0) return;

    // 当前阶段为空或全部完成 → 进入下一阶段
    if (ids.length === 0 || tracked.every(isDone)) {
      if (st.phase === 'assets') {
        st.phase = 'shots';
        console.log('[StoryWorkflow] 资产图生成完毕，开始生成分镜图:', st.shotIds.length);
        // 触发一次重渲染让队列继续跑（nodes 引用未变时 effect 不会自动重跑）
        setNodes(prev => [...prev]);
      } else {
        st.phase = 'done';
        console.log('[StoryWorkflow] 分镜图全部生成完毕');
      }
      return;
    }

    // 队列调度：保持最多 MAX_CONCURRENT 个并发生成
    const inFlight = tracked.filter(n => st.launched.has(n.id) && !isDone(n)).length;
    const pending = tracked.filter(n => !st.launched.has(n.id));
    const slots = MAX_CONCURRENT - inFlight;
    if (slots > 0 && pending.length > 0) {
      pending.slice(0, slots).forEach((n, i) => {
        st.launched.add(n.id);
        setTimeout(() => handleGenerateRef.current(n.id), i * 400);
      });
    }
  }, [nodes]);

  // 批量生成：图片/视频分开统计「未生成 / 失败 / 全部」，重置状态后交给并发队列
  const [isBatchGenOpen, setIsBatchGenOpen] = useState(false);

  const isImageGenNode = (n: NodeData) => n.type === NodeType.IMAGE && !!(n.prompt || '').trim();
  const isVideoGenNode = (n: NodeData) => n.type === NodeType.VIDEO && !!(n.prompt || '').trim();
  const matchScope = (n: NodeData, scope: 'idle' | 'failed' | 'all') =>
    scope === 'idle' ? (n.status === NodeStatus.IDLE && !n.resultUrl)
      : scope === 'failed' ? n.status === NodeStatus.ERROR
        : true;

  const batchGenCounts = React.useMemo(() => {
    const imgs = nodes.filter(isImageGenNode);
    const vids = nodes.filter(isVideoGenNode);
    return {
      image: { idle: imgs.filter(n => matchScope(n, 'idle')).length, failed: imgs.filter(n => matchScope(n, 'failed')).length, all: imgs.length },
      video: { idle: vids.filter(n => matchScope(n, 'idle')).length, failed: vids.filter(n => matchScope(n, 'failed')).length, all: vids.length },
    };
  }, [nodes]);
  const failedNodeCount = batchGenCounts.image.failed + batchGenCounts.video.failed;

  const handleBatchGenerate = React.useCallback((kind: 'image' | 'video', scope: 'idle' | 'failed' | 'all') => {
    const targets = nodes.filter(n => (kind === 'image' ? isImageGenNode(n) : isVideoGenNode(n)) && matchScope(n, scope));
    if (targets.length === 0) return;
    const ids = new Set(targets.map(n => n.id));
    // 重置为待生成（清掉失败信息），由并发队列按 3 个一批调度
    setNodes(prev => prev.map(n => ids.has(n.id) ? { ...n, status: NodeStatus.IDLE, errorMessage: undefined } : n));
    storyAutoGenRef.current = {
      assetIds: kind === 'image' ? targets.map(n => n.id) : [],
      shotIds: kind === 'video' ? targets.map(n => n.id) : [],
      phase: 'assets',
      launched: new Set(),
    };
    setIsBatchGenOpen(false);
  }, [nodes, setNodes]);

  const handleCreateStoryWorkflow = React.useCallback((result: StoryWorkflowResult, opts: { autoGenerate: boolean; aspectRatio?: string }) => {
    const GAP_X = 160;
    const GAP_Y = 70;
    // 统一画幅：分镜图 / 视频 / 场景空镜都用用户选择的比例
    const ratio = opts.aspectRatio === '9:16' ? '9:16' : '16:9';

    // 放到现有节点右侧，避免覆盖
    let baseX = 0;
    if (nodes.length > 0) {
      baseX = Math.max(...nodes.map(n => n.x + getNodeWidth(n))) + 320;
    }

    const defaults = {
      status: NodeStatus.IDLE,
      model: 'Banana Pro',
      imageModel: 'nano-banana-pro',
      videoModel: 'veo3.1-lite',
      resolution: '1K',
    };

    // —— 第 0 列：剧本与风格（Text 节点，仅作参考说明，不连线避免污染提示词）——
    const textNode: NodeData = {
      ...defaults,
      id: crypto.randomUUID(),
      type: NodeType.TEXT,
      title: `剧本 · ${result.title || '未命名'}`,
      x: 0, y: 0,
      prompt: `《${result.title || '未命名'}》\n\n${result.summary || ''}\n\n【风格锚定】${result.styleAnchor || ''}`,
      textMode: 'editing' as const,
      aspectRatio: 'Auto',
      parentIds: [],
    };

    // —— 第 1 列：人物 / 场景 / 道具资产节点 ——
    const assetNameToId = new Map<string, string>();
    const makeAsset = (a: { name: string; prompt: string; desc: string }, kind: string, ratio: string): NodeData => {
      const id = crypto.randomUUID();
      assetNameToId.set(a.name, id);
      return {
        ...defaults,
        id,
        type: NodeType.IMAGE,
        title: `${kind} · ${a.name}`,
        x: 0, y: 0,
        prompt: a.prompt || a.desc || a.name,
        aspectRatio: ratio,
        parentIds: [],
      };
    };
    const assetNodes: NodeData[] = [
      ...(result.characters || []).map(c => makeAsset(c, '角色', '3:4')),
      ...(result.scenes || []).map(s => makeAsset(s, '场景', ratio)),
      ...(result.props || []).map(p => makeAsset(p, '道具', '1:1')),
    ];

    // —— 第 2 列：分镜图片节点（连线引用对应资产）——
    const shotNodes: NodeData[] = (result.shots || []).map((shot, i) => {
      const refNames = [...(shot.characters || []), shot.scene, ...(shot.props || [])].filter(Boolean) as string[];
      const parentIds = refNames
        .map(name => assetNameToId.get(name))
        .filter((id): id is string => !!id)
        .slice(0, 6);
      return {
        ...defaults,
        id: crypto.randomUUID(),
        type: NodeType.IMAGE,
        title: `分镜 ${String(i + 1).padStart(2, '0')}`,
        x: 0, y: 0,
        prompt: shot.imagePrompt || shot.description || '',
        aspectRatio: ratio,
        parentIds,
      };
    });

    // —— 第 3 列：视频节点（连线引用分镜图）——
    const videoNodes: NodeData[] = (result.shots || []).map((shot, i) => ({
      ...defaults,
      id: crypto.randomUUID(),
      type: NodeType.VIDEO,
      title: `镜头 ${String(i + 1).padStart(2, '0')} 视频`,
      x: 0, y: 0,
      prompt: [shot.videoPrompt || shot.description || '', shot.dialogue ? `台词：${shot.dialogue}` : ''].filter(Boolean).join('\n'),
      aspectRatio: ratio,
      videoDuration: Math.max(2, Math.min(15, Number(shot.duration) || 6)),
      parentIds: [shotNodes[i].id],
    }));

    // —— 分列布局（与一键排版一致的间距规则）——
    const columns: NodeData[][] = [[textNode], assetNodes, shotNodes, videoNodes].filter(col => col.length > 0);
    let colX = baseX;
    columns.forEach(col => {
      const colWidth = Math.max(...col.map(n => getNodeWidth(n)));
      const heights = col.map(n => getNodeHeight(n));
      const totalH = heights.reduce((s, h) => s + h, 0) + GAP_Y * (col.length - 1);
      let y = -totalH / 2;
      col.forEach((n, i) => {
        n.x = colX;
        n.y = y;
        y += heights[i] + GAP_Y;
      });
      colX += colWidth + GAP_X;
    });

    const allNew = [textNode, ...assetNodes, ...shotNodes, ...videoNodes];
    setNodes(prev => [...prev, ...allNew]);
    setSelectedNodeIds(allNew.map(n => n.id));

    // 视野自动定位到新工作流
    {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      allNew.forEach(n => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + getNodeWidth(n));
        maxY = Math.max(maxY, n.y + getNodeHeight(n));
      });
      const bw = maxX - minX, bh = maxY - minY;
      const margin = 120;
      const zoom = Math.min(1, Math.max(0.1,
        Math.min((window.innerWidth - margin * 2) / bw, (window.innerHeight - margin * 2) / bh)));
      setViewport({
        x: (window.innerWidth - bw * zoom) / 2 - minX * zoom,
        y: (window.innerHeight - bh * zoom) / 2 - minY * zoom,
        zoom,
      });
    }

    // 自动生图：先资产后分镜（由 effect 中的并发队列驱动，限制同时生成数量）
    if (opts.autoGenerate && assetNodes.length > 0) {
      storyAutoGenRef.current = {
        assetIds: assetNodes.map(n => n.id),
        shotIds: shotNodes.map(n => n.id),
        phase: 'assets',
        launched: new Set(),
      };
    } else {
      storyAutoGenRef.current = null;
    }
  }, [nodes, setNodes, setSelectedNodeIds, setViewport]);

  const handleEditStoryboard = React.useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (group?.storyContext) {
      console.log('[App] Editing storyboard:', groupId);
      storyboardGenerator.editStoryboard(group.storyContext);
    }
  }, [groups, storyboardGenerator]);

  // Storyboard Video Modal State
  const [storyboardVideoModal, setStoryboardVideoModal] = useState<{
    isOpen: boolean;
    nodes: NodeData[];
    storyContext?: { story: string; scripts: any[] };
  }>({ isOpen: false, nodes: [] });

  const handleCreateStoryboardVideo = React.useCallback((targetNodeIds?: string[]) => {
    // Determine which nodes to use: explicit list or current selection
    const nodeIdsToCheck = targetNodeIds || selectedNodeIds;

    // Filter for Image nodes only (can't make video from text/video directly in this flow)
    const selectedImageNodes = nodes.filter(n => nodeIdsToCheck.includes(n.id) && n.type === NodeType.IMAGE);

    if (selectedImageNodes.length === 0) {
      console.warn("No image nodes selected for video generation. Checked IDs:", nodeIdsToCheck);
      return;
    }

    // Check if nodes belong to a group with story context
    const firstNode = selectedImageNodes[0];
    const group = firstNode.groupId ? groups.find(g => g.id === firstNode.groupId) : undefined;
    const storyContext = group?.storyContext;

    if (storyContext) {
      console.log('[App] Found Story Context for Video Modal:', {
        storyLength: storyContext.story.length,
        scriptsCount: storyContext.scripts.length
      });
    }

    setStoryboardVideoModal({
      isOpen: true,
      nodes: selectedImageNodes,
      storyContext
    });
  }, [nodes, selectedNodeIds, groups]);

  const handleGenerateStoryVideos = React.useCallback((
    prompts: Record<string, string>,
    settings: { model: string; duration: number; resolution: string; },
    activeNodeIds?: string[]
  ) => {
    // Close modal
    setStoryboardVideoModal(prev => ({ ...prev, isOpen: false }));

    const newNodes: NodeData[] = [];
    // Use activeNodeIds to filter source nodes if provided, otherwise use all
    const sourceNodes = activeNodeIds
      ? storyboardVideoModal.nodes.filter(n => activeNodeIds.includes(n.id))
      : storyboardVideoModal.nodes;

    // Calculate layout bounds of the ENTIRE storyboard to position videos to the RIGHT
    // Use all storyboard nodes to properly calculate the bounding box
    const allStoryboardNodes = storyboardVideoModal.nodes;

    // Assume a default width if not present (though images usually have it)
    const DEFAULT_WIDTH = 400;

    // Find the rightmost edge of the entire group
    const groupMaxX = Math.max(...allStoryboardNodes.map(n => n.x + ((n as any).width || DEFAULT_WIDTH)));

    // Calculate the left edge of the group to maintain relative offsets
    const groupMinX = Math.min(...allStoryboardNodes.map(n => n.x));

    // Shift Amount: Move everything to the right of the group with a gap
    const GAP_X = 100;
    const xOffset = groupMaxX + GAP_X - groupMinX;

    sourceNodes.forEach((sourceNode) => {
      // Create a new Video node for each image
      const newNodeId = crypto.randomUUID();
      const PROMPT = prompts[sourceNode.id] || sourceNode.prompt || 'Animated video';

      const newVideoNode: NodeData = {
        id: newNodeId,
        type: NodeType.VIDEO,
        // Clone the layout pattern but shifted to the right
        x: sourceNode.x + xOffset,
        y: sourceNode.y,
        prompt: PROMPT,
        status: NodeStatus.IDLE, // Will switch to LOADING when generated
        model: settings.model,
        videoModel: settings.model, // Explicitly set video model
        videoDuration: settings.duration,
        aspectRatio: sourceNode.aspectRatio || '16:9',
        resolution: settings.resolution,
        parentIds: [sourceNode.id], // Connect to source image
        // groupId: undefined, // Explicitly NOT in the group
        videoMode: 'frame-to-frame', // Important for image-to-video
        inputUrl: sourceNode.resultUrl, // Pass image as input
      };

      newNodes.push(newVideoNode);
    });

    // added new nodes to state
    setNodes(prev => [...prev, ...newNodes]);

    // Auto-trigger generation (staggered)
    setTimeout(() => {
      newNodes.forEach((node, index) => {
        setTimeout(() => {
          handleGenerateRef.current(node.id);
        }, index * 1000); // 1s delay between each to avoid rate limits
      });
    }, 500);

  }, [storyboardVideoModal.nodes, setNodes]);

  // Context menu handlers
  const {
    handleDoubleClick,
    handleGlobalContextMenu,
    handleAddNext,
    handleNodeContextMenu,
    handleContextMenuCreateAsset,
    handleContextMenuSelect,
    handleToolbarAdd
  } = useContextMenuHandlers({
    nodes,
    viewport,
    contextMenu,
    setContextMenu,
    handleOpenCreateAsset,
    handleSelectTypeFromMenu
  });

  // Wrapper functions that pass closeWorkflowPanel to panel handlers
  const handleHistoryClick = (e: React.MouseEvent) => {
    panelHistoryClick(e, closeWorkflowPanel);
  };

  const handleAssetsClick = (e: React.MouseEvent) => {
    panelAssetsClick(e, closeWorkflowPanel);
  };

  const handleContextMenuAddAssets = () => {
    openAssetLibraryModal(contextMenu.y, closeWorkflowPanel);
  };

  /**
   * Convert pixel dimensions to closest standard aspect ratio
   */
  const getClosestAspectRatio = (width: number, height: number): string => {
    const ratio = width / height;
    const standardRatios = [
      { label: '1:1', value: 1 },
      { label: '16:9', value: 16 / 9 },
      { label: '9:16', value: 9 / 16 },
      { label: '4:3', value: 4 / 3 },
      { label: '3:4', value: 3 / 4 },
      { label: '3:2', value: 3 / 2 },
      { label: '2:3', value: 2 / 3 },
      { label: '5:4', value: 5 / 4 },
      { label: '4:5', value: 4 / 5 },
      { label: '21:9', value: 21 / 9 }
    ];

    let closest = standardRatios[0];
    let minDiff = Math.abs(ratio - closest.value);

    for (const r of standardRatios) {
      const diff = Math.abs(ratio - r.value);
      if (diff < minDiff) {
        minDiff = diff;
        closest = r;
      }
    }

    return closest.label;
  };

  /**
   * Convert pixel dimensions to closest video aspect ratio (only 16:9 or 9:16)
   */
  const getClosestVideoAspectRatio = (width: number, height: number): string => {
    const ratio = width / height;
    // Video models only support 16:9 (1.78) and 9:16 (0.56)
    // If wider than 1:1 (ratio > 1), use 16:9; otherwise use 9:16
    return ratio >= 1 ? '16:9' : '9:16';
  };

  /**
   * Handle selecting an asset from history - creates new node with the image/video
   */
  const handleSelectAsset = (type: 'images' | 'videos', url: string, prompt: string, model?: string) => {
    // Calculate position at center of canvas
    const centerX = (window.innerWidth / 2 - viewport.x) / viewport.zoom - 170;
    const centerY = (window.innerHeight / 2 - viewport.y) / viewport.zoom - 150;

    // Create node with detected aspect ratio
    const createNode = (resultAspectRatio?: string, aspectRatio?: string) => {
      const isVideo = type === 'videos';
      // Use the original model from asset metadata, or fall back to defaults
      const defaultModel = isVideo ? 'veo-3.1' : 'imagen-3.0-generate-002';
      const nodeModel = model || defaultModel;

      const newNode: NodeData = {
        id: Date.now().toString(),
        type: isVideo ? NodeType.VIDEO : NodeType.IMAGE,
        x: centerX,
        y: centerY,
        prompt: prompt,
        status: NodeStatus.SUCCESS,
        resultUrl: url,
        resultAspectRatio,
        model: nodeModel,
        videoModel: isVideo ? nodeModel : undefined,
        imageModel: !isVideo ? nodeModel : undefined,
        aspectRatio: aspectRatio || '16:9',
        resolution: isVideo ? 'Auto' : '1K'
      };

      setNodes(prev => [...prev, newNode]);
      closeHistoryPanel();
      closeAssetLibrary();
    };

    if (type === 'images') {
      // Detect image dimensions
      const img = new Image();
      img.onload = () => {
        const resultAspectRatio = `${img.naturalWidth}/${img.naturalHeight}`;
        const aspectRatio = getClosestAspectRatio(img.naturalWidth, img.naturalHeight);
        console.log(`[App] Image loaded: ${img.naturalWidth}x${img.naturalHeight} -> ${aspectRatio}`);
        createNode(resultAspectRatio, aspectRatio);
      };
      img.onerror = () => {
        console.log('[App] Image load error, using default 16:9');
        createNode(undefined, '16:9');
      };
      img.src = url;
    } else {
      // Detect video dimensions
      const video = document.createElement('video');
      video.onloadedmetadata = () => {
        const resultAspectRatio = `${video.videoWidth}/${video.videoHeight}`;
        // Use video-specific function that only returns 16:9 or 9:16
        const aspectRatio = getClosestVideoAspectRatio(video.videoWidth, video.videoHeight);
        console.log(`[App] Video loaded: ${video.videoWidth}x${video.videoHeight} -> ${aspectRatio}`);
        createNode(resultAspectRatio, aspectRatio);
      };
      video.onerror = () => {
        console.log('[App] Video load error, using default 16:9');
        createNode(undefined, '16:9');
      };
      video.src = url;
    }
  };

  // 「替换素材」目标节点：非空时从素材库选中的素材会替换该节点内容而不是新建节点
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);

  const handleContextMenuReplaceAsset = () => {
    const id = contextMenu.sourceNodeId;
    const node = id ? nodes.find(n => n.id === id) : undefined;
    if (!node || (node.type !== NodeType.IMAGE && node.type !== NodeType.VIDEO)) {
      showAppAlert('只有图片或视频节点支持替换素材');
      return;
    }
    setReplaceTargetId(id!);
    openAssetLibraryModal(contextMenu.y, closeWorkflowPanel);
  };

  /** 用素材库选中的素材替换目标节点内容（自动检测宽高比，类型不同则切换节点类型） */
  const replaceNodeAsset = (targetId: string, url: string, type: 'image' | 'video') => {
    const apply = (resultAspectRatio?: string, aspectRatio?: string) => {
      updateNode(targetId, {
        type: type === 'video' ? NodeType.VIDEO : NodeType.IMAGE,
        status: NodeStatus.SUCCESS,
        resultUrl: url,
        resultAspectRatio,
        aspectRatio: aspectRatio || '16:9',
        errorMessage: undefined,
      });
      setReplaceTargetId(null);
      closeAssetLibrary();
    };
    if (type === 'image') {
      const img = new Image();
      img.onload = () => apply(`${img.naturalWidth}/${img.naturalHeight}`, getClosestAspectRatio(img.naturalWidth, img.naturalHeight));
      img.onerror = () => apply(undefined, '16:9');
      img.src = url;
    } else {
      const video = document.createElement('video');
      video.onloadedmetadata = () => apply(`${video.videoWidth}/${video.videoHeight}`, getClosestVideoAspectRatio(video.videoWidth, video.videoHeight));
      video.onerror = () => apply(undefined, '16:9');
      video.src = url;
    }
  };

  const handleLibrarySelect = (url: string, type: 'image' | 'video') => {
    if (replaceTargetId) {
      replaceNodeAsset(replaceTargetId, url, type);
      return;
    }
    handleSelectAsset(type === 'image' ? 'images' : 'videos', url, '素材库项目');
    closeAssetLibrary();
  };

  // Create asset modal (isCreateAssetModalOpen, handleOpenCreateAsset, handleSaveAssetToLibrary) provided by useAssetHandlers hook

  // ============================================================================
  // EFFECTS
  // ============================================================================

  // Prevent default zoom behavior
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleNativeWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    canvas.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleNativeWheel);
  }, []);

  /**
   * 一键排版：按依赖深度分层（左→右），列内按父节点位置排序（减少交叉），
   * 排版后自动缩放视野以完整展示所有节点。
   */
  const handleAutoLayout = React.useCallback(() => {
    if (nodes.length === 0) return;

    // 优先用 DOM 实测尺寸（最准确，涵盖竖图限高、控件高度等），未渲染时退回估算
    const sizeOf = (n: NodeData): { w: number; h: number } => {
      const el = document.querySelector(`[data-node-id="${n.id}"]`) as HTMLElement | null;
      if (el && viewport.zoom > 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { w: r.width / viewport.zoom, h: r.height / viewport.zoom };
        }
      }
      return { w: getNodeWidth(n), h: getNodeHeight(n) };
    };
    const sizes = new Map(nodes.map(n => [n.id, sizeOf(n)]));

    const byId = new Map(nodes.map(n => [n.id, n]));
    const depthCache = new Map<string, number>();
    const depthOf = (n: NodeData, stack: Set<string>): number => {
      if (depthCache.has(n.id)) return depthCache.get(n.id)!;
      if (stack.has(n.id)) return 0; // 防御环
      stack.add(n.id);
      const parents = (n.parentIds || []).map(id => byId.get(id)).filter(Boolean) as NodeData[];
      const d = parents.length === 0 ? 0 : Math.max(...parents.map(p => depthOf(p, stack))) + 1;
      depthCache.set(n.id, d);
      return d;
    };
    nodes.forEach(n => depthOf(n, new Set()));

    // 按深度分列
    const cols = new Map<number, NodeData[]>();
    nodes.forEach(n => {
      const d = depthCache.get(n.id)!;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d)!.push(n);
    });
    const sortedDepths = [...cols.keys()].sort((a, b) => a - b);

    // 列内排序：第 0 列按当前 y，其余列按父节点平均序号（重心法）
    const orderIdx = new Map<string, number>();
    sortedDepths.forEach(d => {
      const arr = cols.get(d)!;
      if (d === sortedDepths[0]) {
        arr.sort((a, b) => a.y - b.y);
      } else {
        const bary = (n: NodeData) => {
          const ps = (n.parentIds || []).filter(id => orderIdx.has(id));
          if (ps.length === 0) return Number.MAX_SAFE_INTEGER;
          return ps.reduce((s, id) => s + orderIdx.get(id)!, 0) / ps.length;
        };
        arr.sort((a, b) => bary(a) - bary(b));
      }
      arr.forEach((n, i) => orderIdx.set(n.id, i));
    });

    // 逐列定位：列宽取该列最宽节点，列内垂直居中堆叠
    const GAP_X = 160;
    const GAP_Y = 70;
    const pos = new Map<string, { x: number; y: number }>();
    let colX = 0;
    sortedDepths.forEach(d => {
      const arr = cols.get(d)!;
      const colWidth = Math.max(...arr.map(n => sizes.get(n.id)!.w));
      const heights = arr.map(n => sizes.get(n.id)!.h);
      const totalH = heights.reduce((s, h) => s + h, 0) + GAP_Y * (arr.length - 1);
      let y = -totalH / 2;
      arr.forEach((n, i) => {
        pos.set(n.id, { x: colX, y });
        y += heights[i] + GAP_Y;
      });
      colX += colWidth + GAP_X;
    });

    setNodes(prev => prev.map(n => pos.has(n.id) ? { ...n, x: pos.get(n.id)!.x, y: pos.get(n.id)!.y } : n));

    // 自动缩放视野以容纳全部节点
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      const p = pos.get(n.id);
      if (!p) return;
      const s = sizes.get(n.id)!;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.w);
      maxY = Math.max(maxY, p.y + s.h);
    });
    const bw = maxX - minX, bh = maxY - minY;
    const margin = 120;
    const zoom = Math.min(1, Math.max(0.1,
      Math.min((window.innerWidth - margin * 2) / bw, (window.innerHeight - margin * 2) / bh)));
    setViewport({
      x: (window.innerWidth - bw * zoom) / 2 - minX * zoom,
      y: (window.innerHeight - bh * zoom) / 2 - minY * zoom,
      zoom,
    });
  }, [nodes, viewport.zoom, setNodes, setViewport]);

  // 防止把文件拖进窗口时浏览器/Electron 直接打开该文件（覆盖整个应用页面）
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // Keyboard shortcuts (handleCopy, handlePaste, handleDuplicate) provided by useKeyboardShortcuts hook

  // Cleanup invalid groups (groups with less than 2 nodes)
  useEffect(() => {
    cleanupInvalidGroups(nodes, setNodes);
  }, [nodes, cleanupInvalidGroups]);

  // Track state changes for undo/redo (only after drag ends, not during)
  const isApplyingHistory = React.useRef(false);

  useEffect(() => {
    // Don't push to history if we're currently applying history (undo/redo)
    if (isApplyingHistory.current) {
      isApplyingHistory.current = false;
      return;
    }

    // Don't push to history while dragging (wait until drag ends)
    if (isDragging) {
      return;
    }

    // Push to history when nodes or groups change
    pushHistory({ nodes, groups });
  }, [nodes, groups, isDragging]);

  // Apply history state when undo/redo is triggered
  // IMPORTANT: Don't revert nodes if any node is in LOADING status (generation in progress)
  useEffect(() => {
    // Skip if any node is currently generating - don't interrupt the loading state
    const hasLoadingNode = nodes.some(n => n.status === NodeStatus.LOADING);
    if (hasLoadingNode) {
      return;
    }

    if (historyState.nodes !== nodes) {
      isApplyingHistory.current = true;
      setNodes(historyState.nodes);
    }
  }, [historyState]);

  // Simple wrapper for updateNode (sync code removed - TEXT node prompts are combined at generation time)
  const updateNodeWithSync = React.useCallback((id: string, updates: Partial<NodeData>) => {
    updateNode(id, updates);
  }, [updateNode]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).id === 'canvas-background') {
      // Left-click (button 0): Start selection box
      if (e.button === 0) {
        startSelection(e);
        clearSelection();
        setSelectedConnection(null);
        setContextMenu(prev => ({ ...prev, isOpen: false }));
        closeWorkflowPanel();
        closeHistoryPanel();
        closeAssetLibrary();
      }
      // Middle-click (button 1) or other: Start panning
      else {
        startPanning(e);
        setSelectedConnection(null);
        setContextMenu(prev => ({ ...prev, isOpen: false }));
      }
    }
  };

  const handleGlobalPointerMove = (e: React.PointerEvent) => {
    // 1. Handle Selection Box Update
    if (updateSelection(e)) return;

    // 2. Handle Node Dragging
    if (updateNodeDrag(e, viewport, setNodes, selectedNodeIds)) return;

    // 3. Handle Connection Dragging
    if (updateConnectionDrag(e, nodes, viewport)) return;

    // 4. Handle Canvas Panning (disabled when selection box is active)
    if (!isSelecting) {
      updatePanning(e, setViewport);
    }
  };

  /**
   * Handle when a connection is made between nodes
   * Syncs prompt if parent is a Text node
   */
  const handleConnectionMade = React.useCallback((parentId: string, childId: string) => {
    // Find the parent node
    const parentNode = nodes.find(n => n.id === parentId);
    if (!parentNode) return;

    // If parent is a Text node, sync its prompt to the child
    if (parentNode.type === NodeType.TEXT && parentNode.prompt) {
      updateNode(childId, { prompt: parentNode.prompt });
    }
  }, [nodes, updateNode]);

  const handleGlobalPointerUp = (e: React.PointerEvent) => {
    // 1. Handle Selection Box End
    if (isSelecting) {
      const selectedIds = endSelection(nodes, viewport);
      setSelectedNodeIds(selectedIds);
      releasePointerCapture(e);
      return;
    }

    // 2. Handle Connection Drop
    if (completeConnectionDrag(handleAddNext, setNodes, nodes, handleConnectionMade)) {
      releasePointerCapture(e);
      return;
    }

    // 3. Stop Panning
    endPanning();

    // 4. Stop Node Dragging
    endNodeDrag();

    // 5. Release capture
    releasePointerCapture(e);
  };

  // Context menu handlers provided by useContextMenuHandlers hook
  // handleDoubleClick, handleGlobalContextMenu, handleAddNext, handleNodeContextMenu,
  // handleContextMenuCreateAsset, handleContextMenuSelect, handleToolbarAdd


  return (
    <div className={`w-screen h-screen ${canvasTheme === 'dark' ? 'bg-[#050505] text-white' : 'bg-neutral-50 text-neutral-900'} overflow-hidden select-none font-sans transition-colors duration-300`}>
      {/* 桌面端无边框窗口标题栏 */}
      <DesktopTitleBar />
      {!storyboardGenerator.isModalOpen && (
        <Toolbar
          onAddClick={handleToolbarAdd}
          onWorkflowsClick={handleWorkflowsClick}
          onHistoryClick={handleHistoryClick}
          onAssetsClick={handleAssetsClick}
          onStoryboardClick={storyboardGenerator.openModal}
          onStoryWorkflowClick={() => setIsStoryWorkflowOpen(true)}
          onVideoStudioClick={() => setIsVideoStudioOpen(true)}
          onToolsOpen={() => {
            closeWorkflowPanel();
            closeHistoryPanel();
            closeAssetLibrary();
          }}
          canvasTheme={canvasTheme}
        />
      )}

      {/* Workflow Panel */}
      <WorkflowPanel
        isOpen={isWorkflowPanelOpen}
        onClose={closeWorkflowPanel}
        onLoadWorkflow={handleLoadWithTracking}
        currentWorkflowId={workflowId || undefined}
        panelY={workflowPanelY}
        canvasTheme={canvasTheme}
      />

      {/* History Panel */}
      <HistoryPanel
        isOpen={isHistoryPanelOpen}
        onClose={closeHistoryPanel}
        onSelectAsset={handleSelectAsset}
        panelY={historyPanelY}
        canvasTheme={canvasTheme}
      />

      <AssetLibraryPanel
        isOpen={isAssetLibraryOpen}
        onClose={() => { setReplaceTargetId(null); closeAssetLibrary(); }}
        onSelectAsset={handleLibrarySelect}
        panelY={assetLibraryY}
        variant={assetLibraryVariant}
        canvasTheme={canvasTheme}
      />

      <CreateAssetModal
        isOpen={isCreateAssetModalOpen}
        onClose={() => setIsCreateAssetModalOpen(false)}
        nodeToSnapshot={nodeToSnapshot}
        onSave={handleSaveAssetToLibrary}
      />

      {/* Story Workflow Modal (一键创建工作流) */}
      <StoryWorkflowModal
        isOpen={isStoryWorkflowOpen}
        onClose={() => setIsStoryWorkflowOpen(false)}
        onCreate={handleCreateStoryWorkflow}
      />

      {/* Storyboard Generator Modal */}
      <StoryboardGeneratorModal
        isOpen={storyboardGenerator.isModalOpen}
        onClose={storyboardGenerator.closeModal}
        state={storyboardGenerator.state}
        onSetStep={storyboardGenerator.setStep}
        onToggleCharacter={storyboardGenerator.toggleCharacter}
        onSetSceneCount={storyboardGenerator.setSceneCount}
        onSetStory={storyboardGenerator.setStory}
        onUpdateScript={storyboardGenerator.updateScript}
        onGenerateScripts={storyboardGenerator.generateScripts}
        onBrainstormStory={storyboardGenerator.brainstormStory}
        onOptimizeStory={storyboardGenerator.optimizeStory}
        onGenerateComposite={storyboardGenerator.generateComposite}
        onRegenerateComposite={storyboardGenerator.regenerateComposite}
        onCreateNodes={storyboardGenerator.createStoryboardNodes}
      />

      {/* Agent Chat */}
      {!storyboardGenerator.isModalOpen && (
        <>
          <ChatBubble onClick={toggleChat} isOpen={isChatOpen} />
          <ChatPanel isOpen={isChatOpen} onClose={closeChat} isDraggingNode={isDraggingNodeToChat} canvasTheme={canvasTheme} />
        </>
      )}

      {/* Top Bar */}
      {!storyboardGenerator.isModalOpen && (
        <TopBar
          canvasTitle={canvasTitle}
          isEditingTitle={isEditingTitle}
          editingTitleValue={editingTitleValue}
          canvasTitleInputRef={canvasTitleInputRef}
          setCanvasTitle={setCanvasTitle}
          setIsEditingTitle={setIsEditingTitle}
          setEditingTitleValue={setEditingTitleValue}
          onSave={handleSaveWithTracking}
          onNew={handleNewCanvas}
          hasUnsavedChanges={hasUnsavedChanges}
          isChatOpen={isChatOpen}
          canvasTheme={canvasTheme}
          onToggleTheme={() => setCanvasTheme(prev => prev === 'dark' ? 'light' : 'dark')}
          lastAutoSaveTime={lastAutoSaveTime}
        />
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        id="canvas-background"
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handleGlobalPointerMove}
        onPointerUp={handleGlobalPointerUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleGlobalContextMenu}
      >
        {/* Background Grid：画在屏幕空间（不放进 transform 层），跟随 viewport 平移/缩放平铺。
            这样网格是无限的——不再受固定尺寸网格板的边界限制，缩到 10% 也铺满全屏。
            细网格 + 每 5 格一条主线；缩小时细格屏幕间距过密则隐藏，只留主线。 */}
        {(() => {
          const z = viewport.zoom || 1;
          const sMinor = 28 * z;                     // 细格屏幕间距
          const sMajor = 140 * z;                    // 主线屏幕间距
          const lwMinor = Math.max(1, z);            // 细线屏幕宽：≥1px，放大时随之加粗
          const lwMajor = Math.max(1.5, 1.6 * z);    // 主线更粗
          const showMinor = sMinor >= 13;            // 细格过密时隐藏
          const minorColor = canvasTheme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.065)';
          const majorColor = canvasTheme === 'dark' ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.14)';
          const mc = showMinor ? minorColor : 'transparent';
          const pos = `${viewport.x}px ${viewport.y}px`;
          return (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(${mc} ${lwMinor}px, transparent ${lwMinor}px),
                   linear-gradient(90deg, ${mc} ${lwMinor}px, transparent ${lwMinor}px),
                   linear-gradient(${majorColor} ${lwMajor}px, transparent ${lwMajor}px),
                   linear-gradient(90deg, ${majorColor} ${lwMajor}px, transparent ${lwMajor}px)`,
                backgroundSize: `${sMinor}px ${sMinor}px, ${sMinor}px ${sMinor}px, ${sMajor}px ${sMajor}px, ${sMajor}px ${sMajor}px`,
                backgroundPosition: `${pos}, ${pos}, ${pos}, ${pos}`
              }}
            />
          );
        })()}

        <div
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none'
          }}
        >
          {/* SVG Layer for Connections */}
          <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
            <ConnectionsLayer
              nodes={nodes}
              viewport={viewport}
              canvasTheme={canvasTheme}
              isDraggingConnection={isDraggingConnection}
              connectionStart={connectionStart}
              tempConnectionEnd={tempConnectionEnd}
              selectedConnection={selectedConnection}
              onEdgeClick={handleEdgeClick}
            />
          </svg>

          {/* Nodes Layer */}
          <div className="pointer-events-auto">
            {nodes.map(node => (
              <CanvasNode
                key={node.id}
                data={node}
                inputUrl={(() => {
                  // Get first parent's result for display (multiple inputs handled in generation)
                  if (!node.parentIds || node.parentIds.length === 0) return undefined;
                  const parent = nodes.find(n => n.id === node.parentIds![0]);

                  // VIDEO_EDITOR nodes need the actual video URL from parent Video node
                  if (node.type === NodeType.VIDEO_EDITOR && parent?.type === NodeType.VIDEO) {
                    return parent.resultUrl;
                  }

                  // For other nodes, if parent is video, use lastFrame for image preview
                  if (parent?.type === NodeType.VIDEO && parent.lastFrame) {
                    return parent.lastFrame;
                  }
                  return parent?.resultUrl;
                })()}
                connectedImageNodes={(() => {
                  // Gather all connected parent nodes (image or video) with their URLs
                  if (!node.parentIds || node.parentIds.length === 0) return [];
                  return node.parentIds
                    .map(parentId => nodes.find(n => n.id === parentId))
                    .filter(parent => parent && (parent.type === NodeType.IMAGE || parent.type === NodeType.VIDEO) && parent.resultUrl)
                    .map(parent => ({
                      id: parent!.id,
                      url: (parent!.type === NodeType.VIDEO ? parent!.lastFrame : parent!.resultUrl) || parent!.resultUrl!,
                      type: parent!.type
                    }));
                })()}
                onUpdate={updateNodeWithSync}
                onGenerate={handleGenerate}
                onAddNext={handleAddNext}
                selected={selectedNodeIds.includes(node.id)}
                showControls={selectedNodeIds.length === 1 && selectedNodeIds.includes(node.id)}
                onNodePointerDown={(e) => {
                  // If shift is held, preserve selection for multi-drag/multi-select
                  if (e.shiftKey) {
                    if (selectedNodeIds.includes(node.id)) {
                      handleNodePointerDown(e, node.id, undefined);
                    } else {
                      // Add to selection
                      setSelectedNodeIds(prev => [...prev, node.id]);
                      handleNodePointerDown(e, node.id, undefined);
                    }
                  } else {
                    // No shift: always select just this node (to show its controls)
                    setSelectedNodeIds([node.id]);
                    handleNodePointerDown(e, node.id, undefined);
                  }
                }}
                onContextMenu={handleNodeContextMenu}
                onSelect={(id) => setSelectedNodeIds([id])}
                onConnectorDown={handleConnectorPointerDown}
                isHoveredForConnection={connectionHoveredNodeId === node.id}
                onOpenEditor={handleOpenEditor}
                onUpload={handleUpload}
                onExpand={handleExpandImage}
                onDragStart={handleNodeDragStart}
                onDragEnd={handleNodeDragEnd}
                onWriteContent={handleWriteContent}
                onTextToVideo={handleTextToVideo}
                onTextToImage={handleTextToImage}
                onImageToImage={handleImageToImage}
                onImageToVideo={handleImageToVideo}
                onChangeAngleGenerate={handleChangeAngleGenerate}
                zoom={viewport.zoom}
                onMouseEnter={() => setCanvasHoveredNodeId(node.id)}
                onMouseLeave={() => setCanvasHoveredNodeId(null)}
                canvasTheme={canvasTheme}
              />
            ))}
          </div>



          {/* Selection Bounding Box - for selected nodes (2 or more) */}
          {selectedNodeIds.length > 1 && !selectionBox.isActive && (
            <SelectionBoundingBox
              selectedNodes={nodes.filter(n => selectedNodeIds.includes(n.id))}
              group={getCommonGroup(selectedNodeIds)}
              viewport={viewport}
              onGroup={() => groupNodes(selectedNodeIds, setNodes)}
              onUngroup={() => {
                const group = getCommonGroup(selectedNodeIds);
                if (group) ungroupNodes(group.id, setNodes);
              }}
              onBoundingBoxPointerDown={(e) => {
                // Start dragging all selected nodes when clicking on bounding box
                e.stopPropagation();
                if (selectedNodeIds.length > 0) {
                  handleNodePointerDown(e, selectedNodeIds[0], undefined);
                }
              }}
              onRenameGroup={renameGroup}
              onSortNodes={(direction) => {
                const group = getCommonGroup(selectedNodeIds);
                if (group) sortGroupNodes(group.id, direction, nodes, setNodes);
              }}
              onEditStoryboard={handleEditStoryboard}
            />
          )}

          {/* Group Bounding Boxes - for all groups (even when not selected) */}
          {groups.map(group => {
            const groupNodes = nodes.filter(n => n.groupId === group.id);

            // Don't render if group has less than 2 nodes
            if (groupNodes.length < 2) return null;

            const isSelected = groupNodes.every(n => selectedNodeIds.includes(n.id)) && groupNodes.length > 0;

            // Don't render if this group is already shown above (when selected)
            if (isSelected) return null;

            return (
              <SelectionBoundingBox
                key={group.id}
                selectedNodes={groupNodes}
                group={group}
                viewport={viewport}
                onGroup={() => { }} // Already grouped
                onUngroup={() => ungroupNodes(group.id, setNodes)}
                onBoundingBoxPointerDown={(e) => {
                  // Select all nodes in this group and start dragging
                  e.stopPropagation();
                  const nodeIds = groupNodes.map(n => n.id);
                  setSelectedNodeIds(nodeIds);
                  if (nodeIds.length > 0) {
                    handleNodePointerDown(e, nodeIds[0], undefined);
                  }
                }}
                onRenameGroup={renameGroup}
                onSortNodes={(direction) => sortGroupNodes(group.id, direction, nodes, setNodes)}
                onCreateVideo={() => {
                  // Pass group nodes directly to avoid selection state race conditions
                  const groupNodeIds = nodes.filter(n => n.groupId === group.id).map(n => n.id);
                  handleCreateStoryboardVideo(groupNodeIds);
                }}
                onEditStoryboard={handleEditStoryboard}
              />
            );
          })}
        </div>
      </div >

      {/* Selection Box Overlay - Outside transformed canvas for screen-space coordinates */}
      {selectionBox.isActive && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: Math.min(selectionBox.startX, selectionBox.endX),
            top: Math.min(selectionBox.startY, selectionBox.endY),
            width: Math.abs(selectionBox.endX - selectionBox.startX),
            height: Math.abs(selectionBox.endY - selectionBox.startY),
            border: '2px solid #3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            zIndex: 1000
          }}
        />
      )}

      {/* Context Menu */}
      <ContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(prev => ({ ...prev, isOpen: false }))}
        onSelectType={handleContextMenuSelect}
        onUpload={handleContextUpload}
        onUndo={undo}
        onRedo={redo}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onDuplicate={handleDuplicate}
        onCreateAsset={handleContextMenuCreateAsset}
        onReplaceAsset={handleContextMenuReplaceAsset}
        onAddAssets={handleContextMenuAddAssets}
        canUndo={canUndo}
        canRedo={canRedo}
        canvasTheme={canvasTheme}
      />

      {/* Zoom Slider */}
      {!storyboardGenerator.isModalOpen && (
        <div className={`fixed bottom-6 left-16 rounded-full px-4 py-2 flex items-center gap-3 z-50 transition-colors duration-300 ${canvasTheme === 'dark' ? 'bg-neutral-900 border border-neutral-700' : 'bg-white/90 backdrop-blur-sm border border-neutral-200'}`} >
          <span className={`text-xs ${canvasTheme === 'dark' ? 'text-neutral-400' : 'text-neutral-500'}`}>缩放</span>
          <input
            type="range"
            min="0.1"
            max="2"
            step="0.1"
            value={viewport.zoom}
            onChange={handleSliderZoom}
            className="w-32"
          />
          <span className={`text-xs w-10 ${canvasTheme === 'dark' ? 'text-neutral-300' : 'text-neutral-600'}`}>{Math.round(viewport.zoom * 100)}%</span>
          <div className={`w-px h-4 ${canvasTheme === 'dark' ? 'bg-neutral-700' : 'bg-neutral-300'}`} />
          <button
            onClick={handleAutoLayout}
            disabled={nodes.length === 0}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors disabled:opacity-40 ${canvasTheme === 'dark' ? 'text-neutral-300 hover:bg-neutral-800 hover:text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
            title="按依赖关系自动整理节点布局"
          >
            <LayoutGrid size={13} />
            一键排版
          </button>
          <div className={`w-px h-4 ${canvasTheme === 'dark' ? 'bg-neutral-700' : 'bg-neutral-300'}`} />
          <div className="relative">
            <button
              onClick={() => setIsBatchGenOpen(v => !v)}
              disabled={batchGenCounts.image.all + batchGenCounts.video.all === 0}
              className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors disabled:opacity-40 ${failedNodeCount > 0
                ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                : canvasTheme === 'dark' ? 'text-neutral-300 hover:bg-neutral-800 hover:text-white' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'}`}
              title="批量生成图片/视频（未生成、失败或全部，最多 3 个并发）"
            >
              <RotateCcw size={13} />
              批量生成{failedNodeCount > 0 ? ` (${failedNodeCount} 失败)` : ''}
            </button>

            {isBatchGenOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsBatchGenOpen(false)} />
                <div className={`absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-[300px] p-3 rounded-xl border shadow-2xl ${canvasTheme === 'dark' ? 'bg-neutral-900 border-neutral-700' : 'bg-white border-neutral-200'}`}>
                  {([
                    { kind: 'image' as const, label: '图片', counts: batchGenCounts.image },
                    { kind: 'video' as const, label: '视频', counts: batchGenCounts.video },
                  ]).map(({ kind, label, counts }) => (
                    <div key={kind} className="flex items-center gap-2 py-1.5">
                      <span className={`text-xs font-medium w-8 shrink-0 ${canvasTheme === 'dark' ? 'text-neutral-300' : 'text-neutral-700'}`}>{label}</span>
                      {([
                        { scope: 'idle' as const, text: '未生成', count: counts.idle, cls: 'text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/10' },
                        { scope: 'failed' as const, text: '失败', count: counts.failed, cls: 'text-red-400 border-red-500/30 hover:bg-red-500/10' },
                        { scope: 'all' as const, text: '全部', count: counts.all, cls: 'text-violet-400 border-violet-500/30 hover:bg-violet-500/10' },
                      ]).map(({ scope, text, count, cls }) => (
                        <button
                          key={scope}
                          onClick={() => handleBatchGenerate(kind, scope)}
                          disabled={count === 0}
                          className={`flex-1 px-2 py-1.5 text-[11px] rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${cls}`}
                          title={scope === 'all' ? `重新生成全部${label}（包括已生成的）` : undefined}
                        >
                          {text} {count}
                        </button>
                      ))}
                    </div>
                  ))}
                  <div className={`mt-1.5 pt-1.5 border-t text-[10px] ${canvasTheme === 'dark' ? 'border-neutral-800 text-neutral-600' : 'border-neutral-100 text-neutral-400'}`}>
                    最多 3 个并发，按队列依次生成；「全部」会重新生成已有内容
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ImageEditorModal
        isOpen={editorModal.isOpen}
        nodeId={editorModal.nodeId || ''}
        imageUrl={editorModal.imageUrl}
        initialPrompt={nodes.find(n => n.id === editorModal.nodeId)?.prompt}
        initialModel={nodes.find(n => n.id === editorModal.nodeId)?.imageModel || 'gemini-pro'}
        initialAspectRatio={nodes.find(n => n.id === editorModal.nodeId)?.aspectRatio || 'Auto'}
        initialResolution={nodes.find(n => n.id === editorModal.nodeId)?.resolution || '1K'}
        initialElements={nodes.find(n => n.id === editorModal.nodeId)?.editorElements as any}
        initialCanvasData={nodes.find(n => n.id === editorModal.nodeId)?.editorCanvasData}
        initialCanvasSize={nodes.find(n => n.id === editorModal.nodeId)?.editorCanvasSize}
        initialBackgroundUrl={nodes.find(n => n.id === editorModal.nodeId)?.editorBackgroundUrl}
        onClose={handleCloseImageEditor}
        onGenerate={async (sourceId, prompt, count) => {
          handleCloseImageEditor();

          const sourceNode = nodes.find(n => n.id === sourceId);
          if (!sourceNode) return;

          // Get settings from source node (which were updated by the modal)
          const imageModel = sourceNode.imageModel || 'gemini-pro';
          const aspectRatio = sourceNode.aspectRatio || 'Auto';
          const resolution = sourceNode.resolution || '1K';

          const startX = sourceNode.x + 360; // Source width + gap
          const startY = sourceNode.y;

          const newNodes: NodeData[] = [];

          const yStep = 500;
          const totalHeight = (count - 1) * yStep;
          const startYOffset = -totalHeight / 2;

          // Create N nodes with inherited settings
          for (let i = 0; i < count; i++) {
            newNodes.push({
              id: crypto.randomUUID(),
              type: NodeType.IMAGE,
              x: startX,
              y: startY + startYOffset + (i * yStep),
              prompt: prompt,
              status: NodeStatus.LOADING,
              model: 'Banana Pro',
              imageModel: imageModel,
              aspectRatio: aspectRatio,
              resolution: resolution,
              parentIds: [sourceId]
            });
          }

          // Add new nodes and edges immediately
          // Note: State updates might be batched
          setNodes(prev => [...prev, ...newNodes]);

          // Convert editor image to base64 for generation reference
          let imageBase64: string | undefined = undefined;
          if (editorModal.imageUrl) {
            imageBase64 = await urlToBase64(editorModal.imageUrl);
          }

          newNodes.forEach(async (node) => {
            try {
              const resultUrl = await generateImage({
                prompt: node.prompt || '',
                imageBase64: imageBase64,
                imageModel: imageModel,
                aspectRatio: aspectRatio,
                resolution: resolution
              });
              updateNode(node.id, { status: NodeStatus.SUCCESS, resultUrl });
            } catch (error: any) {
              updateNode(node.id, { status: NodeStatus.ERROR, errorMessage: error.message });
            }
          });
        }}
        onUpdate={updateNode}
      />

      {/* Storyboard Video Generation Modal */}
      <StoryboardVideoModal
        isOpen={storyboardVideoModal.isOpen}
        onClose={() => setStoryboardVideoModal(prev => ({ ...prev, isOpen: false }))}
        scenes={storyboardVideoModal.nodes}
        storyContext={storyboardVideoModal.storyContext}
        onCreateVideos={handleGenerateStoryVideos}
      />

      {/* Video Editor Modal */}
      <VideoEditorModal
        isOpen={videoEditorModal.isOpen}
        nodeId={videoEditorModal.nodeId}
        videoUrl={videoEditorModal.videoUrl}
        initialTrimStart={nodes.find(n => n.id === videoEditorModal.nodeId)?.trimStart}
        initialTrimEnd={nodes.find(n => n.id === videoEditorModal.nodeId)?.trimEnd}
        onClose={handleCloseVideoEditor}
        onExport={handleExportTrimmedVideo}
      />

      {/* Fullscreen Media Preview Modal */}
      <ExpandedMediaModal
        mediaUrl={expandedImageUrl}
        onClose={handleCloseExpand}
      />

      {/* 视频剪辑工作室 */}
      <VideoStudioPage
        isOpen={isVideoStudioOpen}
        onClose={() => setIsVideoStudioOpen(false)}
      />

      {/* 全局统一提示框 */}
      <AppDialogHost />
    </div >
  );
}