/**
 * 剧本 / 分镜对白质量检测（用于调试与优化提示词）
 */

/** 从剧本文本统计对白句数（角色名说："…" 等格式） */
export function countDialogueLines(text) {
    const t = String(text || '');
    const patterns = [
        /[^\n。！？]{0,20}?(?:说|问|答|喊|叫|低声|冷声|沉声|怒道|笑道)[：:]\s*[""「『]([^""」』\n]+)[""」』]/g,
        /[^\n：:]{1,12}[：:]\s*[""「『]([^""」』\n]{2,})[""」』]/g,
    ];
    const lines = [];
    for (const re of patterns) {
        for (const m of t.matchAll(re)) {
            const line = (m[1] || '').trim();
            if (line.length >= 2) lines.push(line);
        }
    }
    return [...new Set(lines)];
}

/** 统计编号节拍数 */
export function countBeats(text) {
    return (String(text || '').match(/^\s*\d+[\.、\)]/gm) || []).length;
}

/** 统计原文引号对话段（粗略） */
export function countSourceQuotes(text) {
    return (String(text || '').match(/[""「『][^""」』\n]{2,}[""」』]/g) || []).length;
}

/**
 * @param {{ screenplay: string, shots?: Array<{ dialogue?: string }>, sourceScript?: string }}
 */
export function analyzeScreenplayQuality({ screenplay, shots = [], sourceScript = '' }) {
    const beats = countBeats(screenplay);
    const dialogueLines = countDialogueLines(screenplay);
    const dialogueLineCount = dialogueLines.length;
    const dialogueChars = dialogueLines.join('').replace(/\s/g, '').length;

    const dialogueBeatRatio = beats > 0 ? dialogueLineCount / beats : 0;

    const shotsWithDialogue = shots.filter(s => String(s.dialogue || '').trim()).length;
    const shotDialogueChars = shots.reduce(
        (sum, s) => sum + String(s.dialogue || '').replace(/\s/g, '').length,
        0,
    );
    const dialogueCoverage = dialogueChars > 0
        ? Math.min(1, shotDialogueChars / dialogueChars)
        : (dialogueLineCount === 0 ? 1 : 0);

    const sourceQuotes = countSourceQuotes(sourceScript);
    const sourceToScreenplayRatio = sourceQuotes > 0 ? dialogueLineCount / sourceQuotes : null;

    const warnings = [];
    if (beats > 0 && dialogueBeatRatio < 0.35) {
        warnings.push(
            `剧本对白节拍偏低（${Math.round(dialogueBeatRatio * 100)}%，建议≥40%），剧情可能靠纯动作堆砌、对话不连贯`,
        );
    }
    if (sourceQuotes >= 5 && sourceToScreenplayRatio !== null && sourceToScreenplayRatio < 0.5) {
        warnings.push(
            `原文约 ${sourceQuotes} 处引号对话，剧本仅保留 ${dialogueLineCount} 句（${Math.round(sourceToScreenplayRatio * 100)}%），核心对白可能被过度删减`,
        );
    }
    if (shots.length > 0 && shotsWithDialogue / shots.length < 0.3 && dialogueLineCount >= 3) {
        warnings.push(
            `仅 ${Math.round((shotsWithDialogue / shots.length) * 100)}% 镜头含台词，观感可能像无声默片`,
        );
    }
    if (dialogueLineCount >= 3 && dialogueCoverage < 0.55) {
        warnings.push(
            `分镜 dialogue 字段覆盖率偏低（${Math.round(dialogueCoverage * 100)}%），部分剧本对白未写入镜头`,
        );
    }

    const grade = warnings.length === 0 ? 'good'
        : warnings.length === 1 ? 'fair' : 'poor';

    return {
        grade,
        beats,
        dialogueLines: dialogueLineCount,
        dialogueBeatRatio: Math.round(dialogueBeatRatio * 100) / 100,
        shotsTotal: shots.length,
        shotsWithDialogue,
        shotDialogueRatio: shots.length ? Math.round((shotsWithDialogue / shots.length) * 100) / 100 : 0,
        dialogueCoverage: Math.round(dialogueCoverage * 100) / 100,
        sourceQuotes,
        warnings,
        summary: `节拍 ${beats} · 对白 ${dialogueLineCount} 句（${Math.round(dialogueBeatRatio * 100)}%）· ${shots.length} 镜中 ${shotsWithDialogue} 镜有台词 · 覆盖率 ${Math.round(dialogueCoverage * 100)}%`,
    };
}
