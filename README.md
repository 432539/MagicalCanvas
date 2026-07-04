<div align="center">
  <img src="public/logo.png" alt="Magical Canvas Logo" width="120" />
  <h1>Magical Canvas 魔法画布</h1>
  <p><strong>AI 创作画布 × 视频剪辑工作室 —— 从一段小说到一部成片，全中文、开箱即用的 Windows 桌面应用</strong></p>

  ![React](https://img.shields.io/badge/React-18-blue)
  ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
  ![Vite](https://img.shields.io/badge/Vite-6-purple)
  ![Electron](https://img.shields.io/badge/Electron-33-teal)
  ![License](https://img.shields.io/badge/license-Apache--2.0-blue)
  ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
</div>

---

**Magical Canvas（魔法画布）** 是一款把「AI 内容生成」与「视频剪辑」融为一体的桌面创作工具，覆盖从创意到成片的完整链路：

- 📖 **一键创作**：丢进一段小说或剧本，AI 自动改编出完整的分镜工作流并批量生图出视频；
- 🎨 **节点画布**：以拖拽连线的方式自由编排 文字 → 图片 → 视频 的 AI 生成流程；
- 🎬 **视频剪辑工作室**：类剪映的多轨时间轴，转场、字幕、AI 配音、贴纸特效、本地导出成片；
- 🤖 **画布 Agent + AI 剪辑助手**：用聊天的方式操作画布、全自动完成粗剪；
- 🖥️ 无需浏览器、无需命令行，下载即用，界面全中文。

## 界面预览

**AI 节点画布** —— 拖拽连线编排生成工作流：

![AI 节点画布](docs/screenshots/canvas.png)

**视频剪辑工作室** —— 多轨时间轴、字幕、配音、贴纸一站式成片：

![视频剪辑工作室](docs/screenshots/studio.png)

## ✨ 功能特性

### 📖 一键创作工作流（小说 / 剧本 → 成片素材）

- **四段式专业流水线**：节拍剧本 → 人物/场景/道具资产 → 电影级分镜 → 解说旁白，一次生成完整工作流
- **专业分镜七要素**：每个镜头包含景别、运镜、场景、主体站位朝向、主体动作、台词、音效，相邻镜头景别自动拉开差距
- **台词说话人标注**：每句对白强制标注角色名，杜绝生成视频时的「串台词」
- **解说旁白**：自动生成贯穿全片的第三人称解说词，可直接送入剪辑页逐句配音
- **提示词模板系统**：内置 3D 漫剧、写实电影、Q 版吉祥物等风格模板，支持查看、编辑、导入文件、保存自定义模板
- **智能镜头数**：可固定镜头数量，也可让 AI 按叙事节奏自动决定
- **关键帧模式**：单帧 / 首尾帧 / 九宫格预览 / AI 智能判断，按镜头复杂度选择最合适的生成方式
- **风格锚定与角色 DNA**：全片统一画风、角色形象一致，创建后自动连线排版、自动批量生图（先资产后分镜）

### 🎨 AI 节点画布

- **节点式工作流**：文本、图片、视频节点自由连线，类型感知校验（文本→图片、图片→视频等）
- **多模态生成**：文生图、文生视频、图生视频、首尾帧动画
- **批量生成与批量停止**：未生成 / 失败 / 全部 三种范围一键批量出图出视频，并发数可调；生成中可**一键停止全部**，立即中止请求、释放资源
- **画布 Agent**：在聊天面板里直接指挥 AI 操作画布——建节点、连线、改提示词、触发生成、删除节点
- **一键排版**：按依赖关系自动分层布局，剧本节点独立成列
- **工作流管理**：保存、加载、分享画布工作流；重启后不会自动续跑生成，状态清晰可控
- **素材库**：生成结果自动入库、可批量存入素材库，随时复用
- **统一模型配置**：文本 / 图片 / 视频 / 语音识别四类模型，均可在设置中自定义 API 地址、密钥与模型名，兼容任意 OpenAI 风格接口

### 🎬 视频剪辑工作室（类剪映体验）

- **多轨时间轴**：视频 / 配音 / 字幕 / 贴纸四轨编辑，拖拽排序、边缘裁剪、滚轮缩放、播放头拖动
- **AI 剪辑助手**：对话式「剪辑导演」——先问清风格与需求，然后一键全自动排列镜头、加转场、生成配音、对齐字幕，停在时间轴等你微调
- **片段属性**：变速（滑杆 + 数值）、音量 / 静音、倒放、旋转翻转、画面调节（亮度 / 对比度 / 饱和度）、缩放与位置
- **丰富转场**：数十种内置转场，支持单独 / 批量应用与实时预览
- **字幕系统**：自定义位置、字号、颜色、背景，8 种经典预设样式
- **智能字幕**：自动提取视频原声 / 配音轨语音并生成时间轴字幕（OpenAI 兼容 ASR 接口）
- **AI 配音**：文案一键转语音（微软 Edge TTS，多种中文音色，免费）
- **贴纸与特效**：内置表情贴纸与画面特效库
- **画面比例**：16:9 / 9:16 横竖屏一键切换
- **素材管理**：批量导入、拖放文件导入、多选删除、一键清空
- **快捷键**：复制 / 剪切 / 粘贴 / 删除 / 撤销 / 重做，右键上下文菜单
- **成片导出**：FFmpeg 本地合成（内置二进制，无需单独安装），720p / 1080p 横竖屏

### 🖥️ 桌面端体验

- **无边框窗口**：自绘标题栏与最小化 / 最大化 / 关闭按钮，深色一体化视觉
- **全中文界面**：所有界面、提示与对话框均为中文，统一风格的应用内弹窗
- **绿色便携**：提供安装版与便携版两种分发形态
- **数据本地化**：API 密钥与素材库存放于本机用户目录，密钥仅在本地后端使用，不经过任何第三方

## 🚀 快速开始

### 直接使用（推荐）

从 [Releases](https://github.com/432539/MagicalCanvas/releases) 下载：

| 文件 | 说明 |
| --- | --- |
| `MagicalCanvas-安装版.exe` | 安装一次，之后秒开（推荐） |
| `MagicalCanvas-便携版.exe` | 免安装单文件，每次启动需解压、较慢 |

首次启动后，点击右上角 **设置** 填入你的模型 API 地址 / 密钥 / 模型名即可开始创作。

### 开发模式

```bash
# 环境要求：Node.js 18+
git clone https://github.com/432539/MagicalCanvas.git
cd MagicalCanvas
npm install

# 同时启动前端 (Vite, :5173) 与后端 (Express, :3501)
npm run dev
```

### 构建与打包

```bash
# 构建前端产物
npm run build

# 打包 Windows 桌面应用（安装版 + 便携版，输出至 release/）
npx electron-builder --win
```

## 🧩 模型配置说明

所有 AI 能力均通过 OpenAI 兼容接口调用，可在「设置」中按类别独立配置：

| 类别 | 用途 | 接口形式 |
| --- | --- | --- |
| 文本模型 | 剧本改编、画布 Agent、剪辑助手、配音脚本 | `POST /chat/completions` |
| 图片模型 | 文生图、图生图 | `POST /images/generations` 等 |
| 视频模型 | 文生视频、图生视频 | OpenAI 兼容视频接口 |
| 语音识别 | 智能字幕（语音转文字） | `POST /audio/transcriptions` |

每个类别均可分别填写 **API 地址、API Key、模型名**，保存后即时生效，无需重启。批量生成的并发数同样在「设置」中调整。

## 🏗️ 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 · TypeScript · Vite · Tailwind CSS |
| 后端 | Node.js · Express（本地服务，托管 API 与静态资源） |
| 桌面 | Electron 33 · electron-builder（NSIS 安装版 + Portable 便携版） |
| 音视频 | FFmpeg（ffmpeg-static 内置）· msedge-tts 语音合成 |
| AI 接入 | OpenAI 兼容 REST 接口（文本 / 图片 / 视频 / ASR）· LangGraph Agent |

## 💬 交流与反馈

- **QQ 交流群：19302577**（使用问题、Bug 反馈、功能建议、创作交流都欢迎）
- 也可在 [Issues](https://github.com/432539/MagicalCanvas/issues) 提交问题或建议

## 🤝 致谢

- 早期画布节点架构参考了 [SankaiAI/TwitCanva-Video-Workflow](https://github.com/SankaiAI/TwitCanva-Video-Workflow)（Apache-2.0），在此基础上重写并扩展出视频剪辑工作室、一键创作流水线、画布 Agent、全中文桌面化等主体功能，详见 [NOTICE](NOTICE)
- [FFmpeg](https://ffmpeg.org/) · [msedge-tts](https://github.com/Migushthe2nd/MsEdgeTTS) · [Electron](https://www.electronjs.org/) · [Lucide Icons](https://lucide.dev/)

## 📄 许可证

本项目以 [Apache License 2.0](LICENSE) 开源协议发布，保留了原始 [NOTICE](NOTICE) 文件并对修改内容作出声明。

使用本软件产生的 AI 内容请遵守所接入模型服务商的使用条款及当地法律法规。
