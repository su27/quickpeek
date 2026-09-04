# QuickPeek

一个面向 Windows 的极简、只读文件查看器。文件完全在本机解析，不会上传。

## 功能

- 启动后驻留系统托盘；资源管理器文件列表获得焦点时，按 `Space` 打开/关闭预览
- 地址栏、搜索框、文件重命名框等输入控件获得焦点时不会接管 `Space`
- 预览窗口出现时不抢走资源管理器焦点，再按一次 `Space` 即可关闭
- 预览期间使用方向键更改选中文件时，窗口保持置顶并自动更新为新的文件
- 也可通过双击关联文件或把文件拖到现有预览窗口打开
- 文件夹使用轻量信息视图预览，不递归读取目录内容
- 预览 DOCX/Open XML 模板、XLS/XLSX/XLSM/XLSB/ODS/CSV/TSV 和 PPTX/Open XML 演示文稿
- 使用 WebView2 原生 PDF 查看器预览 PDF
- 预览 APNG、AVIF、BMP、GIF、ICO、JFIF、JPEG、PNG、SVG 和 WebP 图片
- 图片支持滚轮/触摸板缩放和拖拽浏览；超长图片保持可读的短轴尺寸并在长轴滚动
- 预览常见 MP4/WebM/MOV 视频和 MP3/M4A/WAV/FLAC/Ogg 音频；视频自动播放
- 显示 ZIP 文件目录，但不解压其中的内容
- 预览常见纯文本和源代码；小于等于 2 MB 的常见代码自动高亮
- UTF-8、UTF-16 和中文 Windows 常见 GB18030 文本解码
- 文本超过 20 MB 时只读取并显示前 20 MB，避免大日志拖慢程序
- `Ctrl+F` 按需显示文件内搜索栏；预览时按 `Space` 或 `Esc` 均可关闭
- 无专用渲染器的普通文件仍可预览其图标、类型、大小、修改时间和路径，且不会读取文件内容
- 单实例运行，关闭预览窗口后进程继续驻留，但立即释放当前文件的图片、DOM 和控制器资源
- 隐藏 30 秒后 WebView2 自动进入低内存模式；下次预览前恢复正常模式
- 无预览目标时不显示空窗口；从托盘菜单可完全退出

> 这是只读查看器，不支持旧版 `.doc`、`.ppt`，也不执行宏。由于 Office 文档在浏览器排版能力上的限制，复杂文档的分页、字体和浮动对象可能与 Microsoft Office 略有差异。音视频能否播放取决于系统 WebView2 提供的编解码器。

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

`fixtures/documents/sample.docx` 是一个两页测试文档，可用于快速体验分页和搜索；
`fixtures/documents/table-text-direction.docx` 用于回归测试复杂表格与文字方向。

## 增加预览格式

前端格式能力集中注册在 `src/document-formats.ts`。每个格式适配器负责声明扩展名、MIME、是否支持搜索、读取方式和异步渲染函数，并返回统一的可销毁渲染会话。新增会读取内容的格式时还需要同步更新 `src-tauri/src/lib.rs` 的原生内容读取白名单，以及 `src-tauri/tauri.conf.json` 中需要注册到 Windows 的文件关联。
