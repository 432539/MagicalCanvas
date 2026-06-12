/**
 * ConnectionsLayer.tsx
 * 
 * Renders the SVG connections between nodes on the canvas.
 * Includes permanent connections and temporary drag connections.
 */

import React from 'react';
import { NodeData, NodeStatus, NodeType, Viewport } from '../../types';
import { calculateConnectionPath } from '../../utils/connectionHelpers';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the width of a node based on its type and content
 * @param node - The node to calculate width for
 * @param parentNode - Optional parent node (used for Editor nodes to determine width when they have input content)
 */
export const getNodeWidth = (node: NodeData, parentNode?: NodeData): number => {
    // Image Editor with input from parent: width depends on aspect ratio
    if (node.type === NodeType.IMAGE_EDITOR) {
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput && parentNode.resultAspectRatio) {
            const parts = parentNode.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                // For portrait images: height=500px, width=500*aspectRatio
                // For landscape images: width is capped at 500px
                if (aspectRatio < 1) {
                    return 500 * aspectRatio;
                } else {
                    return 500;
                }
            }
        }
        // Empty: width 340px
        return 340;
    }

    // Video Editor with input: uses 16:9 aspect ratio with maxWidth 500px
    if (node.type === NodeType.VIDEO_EDITOR) {
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput) {
            // Video uses 16:9, and width is capped at 500px
            // height = width / (16/9), maxHeight = 500px
            // So width = min(500, height * 16/9) where height is capped at 500
            // Result: width = min(500, 500 * 16/9) = min(500, 888) = 500
            return 500;
        }
        // Empty: width 340px
        return 340;
    }

    // Video nodes are wider
    if (node.type === NodeType.VIDEO) return 385;
    // Camera Angle nodes have fixed width
    if (node.type === NodeType.CAMERA_ANGLE) return 340;

    // 竖版图片：限高收窄（与 CanvasNode 的卡片宽度规则保持一致）
    if (
        (node.type === NodeType.IMAGE || node.type === NodeType.LOCAL_IMAGE_MODEL) &&
        node.status === NodeStatus.SUCCESS && node.resultUrl && node.resultAspectRatio
    ) {
        const parts = node.resultAspectRatio.split('/');
        if (parts.length === 2) {
            const ar = parseFloat(parts[0]) / parseFloat(parts[1]);
            if (ar > 0 && ar < 1) {
                return Math.max(240, Math.round(460 * ar));
            }
        }
    }

    // Image and other nodes
    return 365;
};

/**
 * Estimate the height of a node based on its type and aspect ratio.
 * The node card height is determined by the content's aspect ratio or min-height for empty states.
 * Note: The title label is positioned ABOVE the card (-top-8), not inside it.
 * @param node - The node to calculate height for
 * @param parentNode - Optional parent node (used for Editor nodes to determine if they have input content)
 */
export const getNodeHeight = (node: NodeData, parentNode?: NodeData): number => {
    const baseWidth = getNodeWidth(node, parentNode);
    const hasContent = node.status === NodeStatus.SUCCESS && node.resultUrl;

    // Handle Image Editor nodes
    if (node.type === NodeType.IMAGE_EDITOR) {
        // Check if has input from parent
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput && parentNode.resultAspectRatio) {
            // Use parent's aspect ratio to calculate actual dimensions
            // Image Editor with content: width=auto maxWidth=500px, image has maxHeight=500px
            const parts = parentNode.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                // For portrait images (aspectRatio < 1): height is capped at 500px
                // For landscape images (aspectRatio >= 1): width is capped at 500px
                if (aspectRatio < 1) {
                    // Portrait: height = 500px, width = 500 * aspectRatio
                    return 500;
                } else {
                    // Landscape: width = 500px, height = 500 / aspectRatio
                    return 500 / aspectRatio;
                }
            }
        }
        // Empty: minHeight 380px
        return 380;
    }

    // Handle Video Editor nodes
    if (node.type === NodeType.VIDEO_EDITOR) {
        // Check if has input from parent
        const hasInput = parentNode && parentNode.status === NodeStatus.SUCCESS && parentNode.resultUrl;
        if (hasInput) {
            // Video editor shows 16:9 when has content (line 301 in CanvasNode.tsx)
            return Math.min(baseWidth / (16 / 9), 500);
        }
        // Empty: minHeight 380px
        return 380;
    }

    // Handle Camera Angle nodes
    if (node.type === NodeType.CAMERA_ANGLE) {
        const hasContent = node.status === NodeStatus.SUCCESS && node.resultUrl;
        if (hasContent && node.resultAspectRatio) {
            // Use actual result dimensions when content exists
            const parts = node.resultAspectRatio.split('/');
            if (parts.length === 2) {
                const aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
                return 340 / aspectRatio; // width is 340px
            }
        }
        // Loading/empty state: minHeight 340px (see CanvasNode.tsx Camera Angle section)
        return 340;
    }

    // Parse aspect ratio to calculate content height for Image/Video nodes
    let aspectRatio: number;

    if (hasContent && node.resultAspectRatio) {
        // Use actual result dimensions when content exists
        const parts = node.resultAspectRatio.split('/');
        if (parts.length === 2) {
            aspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else {
            aspectRatio = 16 / 9;
        }
    } else if (hasContent) {
        // 与 CanvasNode.getAspectRatioStyle 一致：无 resultAspectRatio 的旧内容
        // 视频按 16:9 渲染，图片按 1:1 渲染
        aspectRatio = node.type === NodeType.VIDEO ? 16 / 9 : 1;
    } else {
        // Empty/placeholder state: Both Image and Video use 4/3 (see NodeContent.tsx line 307)
        aspectRatio = 4 / 3;
    }

    // Calculate content height from aspect ratio
    return baseWidth / aspectRatio;
};

interface Connection {
    parentId: string;
    childId: string;
}

// 多套霓虹渐变配色：每条连线按节点 ID 稳定取一套，避免大量平行线颜色单一。
// 4 个色标让渐变过渡更明显，色彩偏赛博霓虹。
const NEON_PALETTES: [string, string, string, string][] = [
    ['#00e5ff', '#2979ff', '#7c4dff', '#e040fb'], // 青 → 蓝 → 紫 → 品红
    ['#b388ff', '#e040fb', '#ff4081', '#ff9e80'], // 紫 → 品红 → 粉 → 珊瑚
    ['#00e676', '#1de9b6', '#00e5ff', '#448aff'], // 绿 → 青绿 → 青 → 蓝
    ['#ffd740', '#ffab40', '#ff6e40', '#ff4081'], // 金 → 橙 → 橘红 → 粉
    ['#18ffff', '#64ffda', '#69f0ae', '#b2ff59'], // 冰青 → 薄荷 → 翠绿 → 黄绿
    ['#8c9eff', '#b388ff', '#ea80fc', '#ff80ab'], // 长春花 → 薰衣草 → 兰紫 → 樱粉
];

/** 字符串稳定哈希（连线两端 ID 决定配色与流速，刷新/拖动不变色） */
const hashStr = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
};

interface ConnectionsLayerProps {
    nodes: NodeData[];
    viewport: Viewport;
    // Connection dragging state
    isDraggingConnection: boolean;
    connectionStart: { nodeId: string; handle: 'left' | 'right' } | null;
    tempConnectionEnd: { x: number; y: number } | null;
    // Selection
    selectedConnection: Connection | null;
    onEdgeClick: (e: React.MouseEvent, parentId: string, childId: string) => void;
    canvasTheme?: 'dark' | 'light';
}

export const ConnectionsLayer: React.FC<ConnectionsLayerProps> = ({
    nodes,
    viewport,
    isDraggingConnection,
    connectionStart,
    tempConnectionEnd,
    selectedConnection,
    onEdgeClick,
    canvasTheme = 'dark'
}) => {
    // Render permanent connections between nodes
    const connections: React.ReactNode[] = [];
    const gradients: React.ReactNode[] = [];

    nodes.forEach(node => {
        if (!node.parentIds || node.parentIds.length === 0) return;

        node.parentIds.forEach(parentId => {
            const parent = nodes.find(n => n.id === parentId);
            if (!parent) return;

            const startX = parent.x + getNodeWidth(parent);
            const startY = parent.y + getNodeHeight(parent) / 2;
            const endX = node.x;
            const endY = node.y + getNodeHeight(node, parent) / 2;

            const path = calculateConnectionPath(startX, startY, endX, endY, 'right');
            const isSelected = selectedConnection?.parentId === parentId && selectedConnection?.childId === node.id;
            const gradId = `conn-grad-${parent.id}-${node.id}`;

            // 按连线两端 ID 稳定选一套霓虹配色 + 微调流速，相邻平行线颜色错开
            const h = hashStr(`${parent.id}-${node.id}`);
            const palette = NEON_PALETTES[h % NEON_PALETTES.length];
            const flowDur = 0.8 + (h % 5) * 0.15; // 0.8s ~ 1.4s

            gradients.push(
                <linearGradient
                    key={gradId}
                    id={gradId}
                    gradientUnits="userSpaceOnUse"
                    x1={startX} y1={startY} x2={endX} y2={endY}
                >
                    <stop offset="0%" stopColor={palette[0]} />
                    <stop offset="38%" stopColor={palette[1]} />
                    <stop offset="70%" stopColor={palette[2]} />
                    <stop offset="100%" stopColor={palette[3]} />
                </linearGradient>
            );

            connections.push(
                <g
                    key={`${parent.id}-${node.id}`}
                    onClick={(e) => onEdgeClick(e, parent.id, node.id)}
                    className="cursor-pointer group pointer-events-auto"
                >
                    <path d={path} stroke="transparent" strokeWidth="20" fill="none" />
                    {/* 霓虹辉光（同渐变的粗低透明度描边，廉价 glow 不用滤镜） */}
                    <path
                        d={path}
                        stroke={`url(#${gradId})`}
                        strokeWidth={isSelected ? 11 : 8}
                        strokeLinecap="round"
                        fill="none"
                        opacity={canvasTheme === 'dark' ? (isSelected ? 0.32 : 0.18) : (isSelected ? 0.22 : 0.12)}
                        className="pointer-events-none transition-all group-hover:opacity-40"
                    />
                    {/* 彩色渐变主线 */}
                    <path
                        d={path}
                        stroke={`url(#${gradId})`}
                        strokeWidth={isSelected ? 3.5 : 2.5}
                        strokeLinecap="round"
                        fill="none"
                        opacity={isSelected ? 1 : 0.95}
                        className="transition-all group-hover:opacity-100"
                    />
                    {/* 流动光点（虚线滚动动画，速度随连线微差更有层次） */}
                    <path
                        d={path}
                        stroke={canvasTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.95)'}
                        strokeWidth={isSelected ? 2 : 1.6}
                        strokeLinecap="round"
                        strokeDasharray="3 17"
                        fill="none"
                        style={{ animation: `connFlow ${flowDur}s linear infinite` }}
                        className="pointer-events-none"
                    />
                </g>
            );
        });
    });

    // Render temporary drag connection
    let tempLine = null;
    if (isDraggingConnection && connectionStart && tempConnectionEnd) {
        const startNode = nodes.find(n => n.id === connectionStart.nodeId);
        if (startNode) {
            const startX = connectionStart.handle === 'right' ? startNode.x + getNodeWidth(startNode) : startNode.x;
            const startY = startNode.y + getNodeHeight(startNode) / 2;
            const endX = (tempConnectionEnd.x - viewport.x) / viewport.zoom;
            const endY = (tempConnectionEnd.y - viewport.y) / viewport.zoom;

            const path = calculateConnectionPath(
                startX,
                startY,
                endX,
                endY,
                connectionStart.handle
            );

            tempLine = (
                <path
                    d={path}
                    stroke={canvasTheme === 'dark' ? '#fff' : '#2563eb'}
                    strokeWidth="2"
                    strokeDasharray="5,5"
                    fill="none"
                    className="pointer-events-none opacity-50"
                />
            );
        }
    }

    return (
        <>
            <defs>{gradients}</defs>
            <style>{`@keyframes connFlow { to { stroke-dashoffset: -20; } }`}</style>
            {connections}
            {tempLine}
        </>
    );
};
