/**
 * useGenerationRecovery.ts
 * 
 * Custom hook that checks for nodes in 'loading' status and polls
 * the backend to see if their generation has finished.
 */

import { useEffect, useCallback, useRef } from 'react';
import { NodeData, NodeStatus } from '../types';
import { extractVideoLastFrame } from '../utils/videoHelpers';

interface UseGenerationRecoveryOptions {
    nodes: NodeData[];
    updateNode: (id: string, updates: Partial<NodeData>) => void;
}

export const useGenerationRecovery = ({
    nodes,
    updateNode
}: UseGenerationRecoveryOptions) => {
    // Use a ref to access current nodes without causing re-renders
    const nodesRef = useRef<NodeData[]>(nodes);
    nodesRef.current = nodes;

    const checkStatus = useCallback(async (nodeId: string) => {
        try {
            const response = await fetch(`/api/generation-status/${nodeId}`);
            if (response.ok) {
                const data = await response.json();
                if (data.status === 'success' && data.resultUrl) {
                    // Access nodes via ref to avoid stale closure
                    const node = nodesRef.current.find(n => n.id === nodeId);

                    // Race condition check: If node has a generationStartTime, compare with result's createdAt
                    // This prevents applying stale results from previous generations
                    if (node?.generationStartTime && data.createdAt) {
                        const resultCreatedAt = new Date(data.createdAt).getTime();
                        if (resultCreatedAt < node.generationStartTime) {
                            // Stale result, skip silently (don't spam console)
                            return;
                        }
                    }

                    console.log(`[Recovery] Found new result for node ${nodeId}`);

                    // Update node with success status and result URL
                    const updates: Partial<NodeData> = {
                        status: NodeStatus.SUCCESS,
                        resultUrl: data.resultUrl,
                        errorMessage: undefined,
                        generationStartTime: undefined // Clear the timestamp after successful recovery
                    };

                    // If it's a video, extract the last frame for chaining
                    if (data.type === 'video') {
                        try {
                            const lastFrame = await extractVideoLastFrame(data.resultUrl);
                            updates.lastFrame = lastFrame;
                        } catch (err) {
                            console.error(`[Recovery] Failed to extract last frame for node ${nodeId}:`, err);
                        }
                    }

                    updateNode(nodeId, updates);
                } else if (data.status === 'stale') {
                    // 服务器没有结果文件、也没有进行中的任务 → 生成在应用关闭/重启时中断了。
                    // 用 generationStartTime 防误判：刚发起的生成（图片转 base64 等准备阶段）
                    // 请求可能还没到服务器，60 秒内不判定中断。
                    const node = nodesRef.current.find(n => n.id === nodeId);
                    const startedAt = node?.generationStartTime;
                    if (!startedAt || Date.now() - startedAt > 60000) {
                        console.log(`[Recovery] Node ${nodeId} generation was interrupted (app restart)`);
                        updateNode(nodeId, {
                            status: NodeStatus.ERROR,
                            errorMessage: '生成已中断（应用关闭/重启），请点击重试或使用批量生成',
                            generationStartTime: undefined,
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`[Recovery] Error checking status for node ${nodeId}:`, error);
        }
    }, [updateNode]); // Only updateNode as dependency, nodes accessed via ref

    // Track loading node IDs for stable dependency
    const loadingNodeIds = nodes
        // 产品最终成片由 /api/video-studio/export 负责，不属于 generation-status 管理的
        // 图片/视频生成任务；若参与轮询，长导出会被误判为 stale 并标记失败。
        .filter(n => n.status === NodeStatus.LOADING && n.adRole !== 'final-video')
        .map(n => n.id)
        .join(',');

    useEffect(() => {
        if (!loadingNodeIds) return;

        const nodeIds = loadingNodeIds.split(',');

        // Check each loading node every 10 seconds
        const checkAll = () => {
            nodeIds.forEach(nodeId => checkStatus(nodeId));
        };

        checkAll(); // Initial check

        const interval = setInterval(checkAll, 10000); // Check every 10s

        return () => clearInterval(interval);
    }, [loadingNodeIds, checkStatus]); // Stable string dependency instead of nodes array
};

