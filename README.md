# QuickPeek

一个面向 Windows 的极简、只读文件查看器。文件完全在本机解析，不会上传。

## 功能

- 启动后驻留系统托盘；资源管理器或桌面文件列表获得焦点时，按 `Space` 打开/关闭预览
- 地址栏、搜索框、文件重命名框等输入控件获得焦点时不会接管 `Space`
- 预览窗口出现时不抢走资源管理器焦点，再按一次 `Space` 即可关闭
- 预览期间使用方向键或鼠标更改选中文件时，窗口保持置顶并自动更新为新的文件
- 也可通过双击关联文件或把文件拖到现有预览窗口打开
- 文件夹使用轻量信息视图预览，不递归读取目录内容
- 预览 DOCX/Open XML 模板、XLS/XLSX/XLSM/XLSB/ODS/CSV/TSV 和 PPTX/Open XML 演示文稿
- 旧版 `.doc`、`.ppt/.pps/.pot` 在系统已注册 Preview Handler 时调用该处理器预览；不可用或加载失败时自动显示文件信息
- RTF 使用系统 Rich Edit 只读控件预览，不依赖 Word，不允许嵌入 OLE 对象；输入限制 20 MB
- TTF/OTF/WOFF/WOFF2 字体样张，按需注册到当前 WebView，关闭即移除，不安装到系统；限制 20 MB
- EPUB 2/3 电子书：纸色背景、舒适字号、收起式章节目录、上一章/下一章、书内跳转、常见插图与表格；按章节滚动阅读，`Ctrl+F` 搜索当前章节
- EPUB 复用现有 ZIP 库，不添加阅读引擎；只解压当前章节和图片。压缩源文件上限 64 MB，单章 2 MB，单张图片 8 MB / 1600 万像素，章节图片总计 24 MB / 3200 万像素。关闭后释放当前书籍、章节和图片，不保留书籍缓存
- EPUB 不执行书内脚本、不请求远程资源、不应用出版者 CSS/嵌入字体；不支持 DRM、音视频及固定版式的精确还原，优先保证正文可读性
- 使用 Windows 系统 PDF 渲染 API 预览 PDF，按最终窗口尺寸绘制首屏
- 预览 APNG、AVIF、BMP、GIF、ICO、JFIF、JPEG、PNG、SVG 和 WebP 图片
- HEIC/HEIF 通过 Windows 系统图片解码器预览，需要系统安装相应编解码器
- HEIC/HEIF 不透明照片以质量 92 的 JPEG 中转，带透明通道的图像仍用 PNG；按当前屏幕物理像素限制解码，最长边不超过 4096，不放大小图，超长图保留原有 4096 像素预算。保留 EXIF 方向和 sRGB 色彩转换；关闭不保留转换缓存，过期请求跳过后续解码/编码阶段。
- TIFF/TIF 使用系统解码器，多页文件通过浮动翻页按钮按页读取；每页最长边限制为 4096 像素，不缓存历史页
- 图片支持滚轮/触摸板缩放和拖拽浏览；超长图片保持可读的短轴尺寸并在长轴滚动
- 预览常见 MP4/WebM/MOV 视频和 MP3/M4A/WAV/FLAC/Ogg 音频；音视频自动播放
- ZIP/JAR/WAR/APK/VSIX/NUPKG 直接读取中央目录，不把整个压缩包加载到内存；显示原始大小、压缩后大小和修改时间
- ZIP 支持 UTF-8 标记和带 CRC 校验的 Unicode Path 扩展字段；没有编码标记的旧 ZIP 保留 CP437 回退。Windows tar 输出按系统 ANSI 编码读取，避免中文 RAR 文件名乱码；这些路径只用于目录展示，不解压或执行文件。
- 压缩包按可折叠目录树展示；自动补齐路径中隐含的文件夹，保留空目录，同级文件夹优先。目录树最多展示 10000 个节点、128 层路径，超过限制明确提示截断。
- TAR/TAR.GZ/TGZ/TAR.BZ2/TBZ2/TAR.XZ/TXZ/TAR.ZST/7Z/RAR 通过 Windows 自带 tar 尝试列目录，不解压文件；实际能力取决于系统 tar 版本，取不到大小/日期时显示横线
- 压缩包目录最多显示 5000 项，名称输出限制 2 MB；系统 tar 任务上限 8 秒，切换/关闭时取消并终止子进程
- 预览常见纯文本和源代码；小于等于 2 MB 的常见代码自动高亮
- UTF-8、UTF-16 和中文 Windows 常见 GB18030 文本解码
- 文本超过 20 MB 时只读取并显示前 20 MB，避免大日志拖慢程序
- `Ctrl+F` 按需显示文件内搜索栏；预览时按 `Space` 或 `Esc` 均可关闭
- 无专用渲染器的普通文件仍可预览其图标、类型、大小、修改时间和路径，且不会读取文件内容
- 单实例运行，关闭预览窗口后进程继续驻留，但立即释放当前文件的图片、DOM 和控制器资源
- 关闭时中止读取、销毁播放器/当前预览，并等待暂存预览完成清理，再立即挂起 WebView2；不再等待 30 秒。成功挂起后仅对自身及所属 WebView2 进程做一次驻留内存回收，下次预览前恢复。保留窗体和引擎，不强制 GC 或定时清内存；引擎/GPU 保留的提交内存不等于已释放，也不保证恢复到冷启动基线。
- 无预览目标时不显示空窗口；从托盘菜单可完全退出
- 打开超过 250 ms 才显示原生深色加载动画，快速文件直接显示最终预览；动画不依赖网页线程，不额外延迟完成后的显示。切换/关闭使旧请求的提示失效，空格/Esc 在加载期间也可取消

> 这是只读查看器。QuickPeek 自身不执行宏，不内置 Word、LibreOffice 或新的解码运行时。旧版 Office 文件的实际预览能力和安全行为取决于 Windows 中已安装的第三方预览处理器。由于 Office 文档在浏览器排版能力上的限制，复杂文档的分页、字体和浮动对象可能与 Microsoft Office 略有差异。音视频能否播放取决于系统 WebView2 提供的编解码器。

## 开发运行

```powershell
npm install
npm run tauri dev
```

## 构建 Windows 安装包

```powershell
npm run tauri build
```

安装包生成在 `src-tauri/target/release/bundle/nsis/`。

## 开发检查

使用 Node.js 22.14 或更新版本运行测试；原生构建需要 Rust 和 Windows C++ 构建工具。

```powershell
npm run check
npm test
npm run test:native
npm run build
npm run test:browser
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

浏览器回归测试使用本机 Microsoft Edge 的独立无头实例，覆盖 EPUB、字体、图片、TIFF、压缩包、PDF 和预览窗口状态。音视频浏览器测试需要提供本地样例：`npm run test:media:browser -- "C:\path\sample.mov"`，可以传入多个文件。`scripts/` 中的内存分析及原生界面诊断脚本按需运行，不包含在默认测试中。

发布时同步更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 及两份锁文件中的应用版本，再运行检查与安装包构建。

`fixtures/documents/sample.docx` 是一个两页测试文档，可用于快速体验分页和搜索；
`fixtures/documents/table-text-direction.docx` 用于回归测试复杂表格与文字方向。

## 增加预览格式

前端格式能力集中注册在 `src/document-formats.ts`。每个格式适配器负责声明扩展名、MIME、是否支持搜索、读取方式和异步渲染函数，并返回统一的可销毁渲染会话。新增会读取内容的格式时还需要同步更新 `src-tauri/src/lib.rs` 的原生内容读取白名单，以及 `src-tauri/tauri.conf.json` 中需要注册到 Windows 的文件关联。

### 旧版 DOC 系统预览

`.doc` 只传递本地文件路径给已注册的 Windows Preview Handler，不引入转换引擎或额外运行时。系统未安装处理器、处理器失败或响应超时时，回退为文件信息。处理器在独立 STA 线程中运行，其自身占用的内存取决于系统安装的软件；QuickPeek 关闭预览时调用 `Unload` 释放会话。第三方处理器仍可能在 QuickPeek 进程内运行，本实现不是独立进程沙箱。

回归检查：`npm run check`、`powershell -File scripts/test-native.ps1`（为原生测试程序嵌入 Common Controls v6 清单）。另有不显示窗口的可选系统集成测试，需要本机安装 DOC 处理器，并将 `QUICKPEEK_DOC_FIXTURE` 设置为可信 `.doc` 样例路径：

```powershell
powershell -File scripts/test-native.ps1 native_doc_lifecycle --ignored
```
