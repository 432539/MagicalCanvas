#!/usr/bin/env node
/**
 * 剧本对白质量检测 CLI
 *
 * 用法：
 *   node scripts/test-screenplay-quality.mjs --screenplay path/to/screenplay.txt
 *   node scripts/test-screenplay-quality.mjs --screenplay screenplay.txt --source novel.txt
 *   node scripts/test-screenplay-quality.mjs --screenplay screenplay.txt --shots result.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeScreenplayQuality } from '../server/utils/screenplay-quality.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readArg(flag) {
    const i = process.argv.indexOf(flag);
    if (i === -1 || !process.argv[i + 1]) return '';
    return process.argv[i + 1];
}

function readFile(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    if (!fs.existsSync(abs)) {
        console.error(`文件不存在: ${abs}`);
        process.exit(1);
    }
    return fs.readFileSync(abs, 'utf8');
}

const screenplayPath = readArg('--screenplay');
if (!screenplayPath) {
    console.log(`剧本对白质量检测

用法:
  node scripts/test-screenplay-quality.mjs --screenplay <剧本.txt>
  node scripts/test-screenplay-quality.mjs --screenplay <剧本.txt> --source <原文小说.txt>
  node scripts/test-screenplay-quality.mjs --screenplay <剧本.txt> --shots <分镜结果.json>

指标说明:
  · 对白节拍比 ≥40% 为佳（有对白的节拍 / 总节拍）
  · 分镜 dialogue 覆盖率 ≥55% 为佳（镜头台词字数 / 剧本台词字数）
  · grade: good / fair / poor
`);
    process.exit(0);
}

const screenplay = readFile(screenplayPath);
const sourceScript = readArg('--source') ? readFile(readArg('--source')) : '';
let shots = [];
const shotsPath = readArg('--shots');
if (shotsPath) {
    const raw = JSON.parse(readFile(shotsPath));
    shots = raw.shots || raw.data?.shots || raw;
    if (!Array.isArray(shots)) {
        console.error('--shots 需为 JSON 数组或含 shots 字段的对象');
        process.exit(1);
    }
}

const q = analyzeScreenplayQuality({ screenplay, shots, sourceScript });

console.log('\n=== 剧本对白质量报告 ===\n');
console.log(`等级: ${q.grade.toUpperCase()}`);
console.log(q.summary);
console.log('');
console.log(`  节拍总数:        ${q.beats}`);
console.log(`  对白句数:        ${q.dialogueLines}`);
console.log(`  对白节拍比:      ${Math.round(q.dialogueBeatRatio * 100)}%`);
if (q.sourceQuotes) console.log(`  原文引号对话:    ${q.sourceQuotes} 处`);
if (shots.length) {
    console.log(`  有台词镜头:      ${q.shotsWithDialogue} / ${q.shotsTotal} (${Math.round(q.shotDialogueRatio * 100)}%)`);
    console.log(`  台词覆盖率:      ${Math.round(q.dialogueCoverage * 100)}%`);
}
if (q.warnings.length) {
    console.log('\n⚠ 问题:');
    q.warnings.forEach(w => console.log(`  · ${w}`));
} else {
    console.log('\n✓ 未发现明显对白问题');
}
console.log('');
