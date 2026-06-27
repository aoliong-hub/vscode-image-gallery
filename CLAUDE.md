# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指引。

## 项目概述

VS Code 扩展（"Image Gallery"），在 VS Code 内提供图片浏览功能，针对远程/云开发（如 SSH）场景优化。两个核心功能：gallery webview 按文件夹层级展示所有图片；viewer 自定义编辑器查看单张图片并支持缩放平移。通过虚拟滚动和服务端缩略图生成，可流畅处理 5000+ 张图片。

## 构建与开发命令

```bash
npm install --ignore-scripts   # 安装依赖（跳过 keytar 等原生模块编译）
npm run compile                # webpack 开发构建
npm run watch                  # webpack 监听模式构建
npm run package                # webpack 生产构建（含 hidden source map）
npm run lint                   # eslint 检查 src/**/*.ts
npm run compile-tests          # 用 tsc 编译测试到 dist/
npm run pretest                # compile-tests + compile + lint（三步）
npm run test                   # 运行集成测试（需要 @vscode/test-electron 提供的 VS Code 实例）
npm run local-deploy           # 本地打包 .vsix 文件
npm run deploy                 # 发布到 VS Code 插件市场（via vsce）
```

测试使用 Mocha（TDD 风格）在 Extension Host 中运行，属于 VS Code 集成测试，无法无界面运行——CI 仅编译不执行。本地调试测试使用 VS Code 的 "Run Test" 启动配置，测试工作区为 `src/test/samples/`。

## 远程机器安装步骤

```bash
# 1. 本地打包 .vsix
npm run local-deploy

# 2. 将 .vsix 传到远程机器后安装
code --install-extension vscode-image-gallery-1.2.1.vsix

# 3. 在远程机器的扩展目录中安装 sharp（图像处理原生模块）
cd ~/.vscode-server/extensions/geriyoco.vscode-image-gallery-1.2.1
npm install sharp --ignore-scripts

# 4. 重新加载 VS Code 窗口：Ctrl+Shift+P → "Developer: Reload Window"
```

必须使用 `--ignore-scripts`，因为 `keytar`（`@vscode/extension-telemetry` 的间接依赖）编译需要 `libsecret-1`，但运行时并不需要它。sharp 使用预编译二进制包，不需要编译。

## 架构

扩展在 `extension.ts` 中注册两个激活时模块：

**Gallery**（`src/gallery/`）— 命令 `gryc.openGallery`，从资源管理器右键菜单触发。创建 webview 面板：
1. 用 `vscode.workspace.findFiles` 递归查找所有图片文件，glob 模式从 `package.json` 中的支持格式派生
2. 将图片归组为 `TFolder`/`TImage` 结构（以路径的 SHA-256 哈希为 key）
3. 通过 `sharp` 生成缩略图（200px 宽 JPEG，质量 60%），以 base64 data URI 嵌入——网格展示不传输原图
4. 通过 `postMessage` 分批发送数据（每批约 200 张），每批到达后立即渲染，实现渐进式显示
5. 使用虚拟滚动（`script.js` 中的 `VirtualScroller` 类）——仅渲染视口 ± 1500px 缓冲区内的 DOM 节点，二分查找确定可见范围
6. 使用 `ImageLoader` 类控制图片加载并发（最大 12），并缓存已加载图片的 src URL
7. 在 `.gallery-content` 上使用事件委托代替逐图片绑定监听器
8. 文件系统监听采用防抖增量更新（300ms 缓冲，超过 50 条变更降级为全量刷新）

**Viewer**（`src/viewer/`）— 自定义只读编辑器（`gryc.viewer`），注册为常见图片格式的默认处理器。使用 `panzoom` 库实现原图缩放平移。

### 消息协议

Gallery 使用 `POST.gallery.*` 命名规范在 webview 与 extension host 之间通信：

| 方向 | 消息 | 用途 |
|------|------|------|
| webview → ext | `requestContentDOMs` | 请求所有图片数据 |
| webview → ext | `requestSort` | 请求按 name/ext/size/ctime/mtime 重新排序 |
| ext → webview | `responseContentBatch` | 一批文件夹+图片数据（≤200 张） |
| ext → webview | `responseContentComplete` | 所有批次发送完毕，触发清理过期文件夹 |
| ext → webview | `responseDeltaCreate` | 单张图片/文件夹新增 |
| ext → webview | `responseDeltaDelete` | 单张图片/文件夹删除 |
| ext → webview | `responseDeltaChange` | 单张图片修改 |

### 性能架构

支撑 5000+ 图片的关键设计：

- **缩略图生成**（`utils.ts`）：`sharp` 将原图缩放为 200px 宽 JPEG 缩略图（每张约 10KB，原图 2-10MB）。结果缓存在内存 `thumbnailCache` Map 中。每个文件夹内以 20 并发调用 `asyncPool` 生成缩略图。
- **分批传输**（`gallery.ts`）：`sendContentBatches()` 按文件夹为单位累积到约 200 张图时发送一批，生成缩略图后立即发送——用户立刻看到内容渐进出现。
- **虚拟滚动**（`script.js`）：`VirtualScroller` 维护 `layoutEntries` 数组，将每个文件夹栏和图片行映射到绝对 `top` 位置。滚动时（`requestAnimationFrame` 节流），二分查找可见条目，仅创建这些条目的 DOM 节点，滚出视口的节点被移除。
- **并发限制**（`utils.ts`）：`asyncPool(concurrency, items, fn)` 将并行 `fs.stat` 调用限制为 50、缩略图生成限制为 20，防止远程文件系统上文件描述符耗尽。
- **图片加载队列**（`script.js`）：`ImageLoader` 限制最大 12 并发加载，在 `loadedSrcs` Map 中缓存已加载的 src URL，滚回已浏览区域时瞬间显示。
- **文件监听防抖**（`gallery.ts`）：`queueDelta`/`flushDeltas` 将文件系统事件缓冲 300ms。≤50 条事件发送单独的 delta 消息；>50 条降级为全量分批刷新。

**公共模块**：
- `utils.ts` — `asyncPool`、路径哈希、glob 生成、文件 stat、`generateThumbnail`/`generateThumbnails`（基于 sharp）
- `html_provider.ts` — 生成所有 gallery HTML，带 CSP nonce；有缩略图时使用 TImage 的 `thumbnailDataUri`
- `custom_typings.ts` — 声明 `TImage`（含可选 `thumbnailDataUri`）和 `TFolder` 类型的 ambient module
- `telemetry.ts` — 封装 `@vscode/extension-telemetry`，支持扩展级遥测开关

## 关键模式

- 支持的图片格式在 `package.json` 的 `contributes.customEditors[0].selector[0].filenamePattern` 中统一定义，运行时读取——其他地方不硬编码。
- 图片/文件夹 ID 是 URI 路径的 SHA-256 哈希（截取 16 位十六进制，前缀 'H'）。
- webview JS（`src/gallery/script.js` 和 `src/viewer/script.js`）是纯 JS 而非 TypeScript，运行在 webview 上下文中（无 Node.js API）。
- CSP nonce 在扩展激活时生成一次，所有 webview 共享。CSP `img-src` 指令包含 `data:` 以允许 base64 缩略图 URI。
- Webpack 仅打包 extension host 代码（`src/extension.ts` 入口 → `dist/extension.js`）。webview 资源（JS、CSS）运行时直接从 `src/` 加载。`sharp` 在 webpack `externals` 中声明为原生模块。
- `custom_typings` 模块是 ambient module，通过 TypeScript 的 `paths` 或 `baseUrl` 解析——不是常规导入路径。
