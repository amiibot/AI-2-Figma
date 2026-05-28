# Notice Structure Rebuilder

一个独立的 Figma 插件实验项目，用来把 Illustrator 导出的公告类 SVG 先抽成结构数据，再在 Figma 中按章节重建。

当前这条链路已经打通：

- 从 SVG 抽取章节结构
- 识别 `background / title / body`
- 输出 `structure.json` 和 `report.json`
- 在 Figma 中重建画板、章节背景、标题、正文
- 当正文高度增长时，让当前 section 增高，并把后续 section 整体下推

## 当前适用场景

当前主要服务于：

- 单列
- 自上而下纵向堆叠
- 每个章节由大背景矩形 + 标题 + 正文组成

如果后续素材是多列、交错排版、浮动元素覆盖、或不是线性文档流，这一版的下推逻辑就不够，需要升级布局模型。

## 目录结构

```text
notice-multilang-plugin/
  manifest.json
  code.js
  ui.html
  generate_structure.py
  generator.config.json
  test.svg
  test-board.svg
  out/
    structure.json
    report.json
```

## 处理流程

```text
SVG
  -> generate_structure.py
  -> out/structure.json + out/report.json
  -> Figma plugin UI
  -> code.js rebuild
```

设计上，`structure.json` 是重建阶段的稳定输入契约。

## 文件说明

### `generate_structure.py`
把 SVG 解析成结构化 JSON。

目前会抽取：

- `artboard`
- section 列表
- section `frame`
- `background / title / body`
- 文本内容
- 基础样式
  - solid fill
  - linear gradient
  - stroke
  - fontSize
  - fontFamily
  - fontWeight
- 基础几何
  - `x / y / width / height`
  - 文本推导出的 `lineHeight / lineCount`

### `out/structure.json`
Figma 重建真正消费的输入。

### `out/report.json`
用于预览、调试、检查章节状态。

### `code.js`
Figma 主线程：

- 校验结构数据
- 创建页面/画板
- 按绝对坐标重建 section
- 写入背景、标题、正文
- 根据正文实际高度扩展 section，并顺推后续 section

### `ui.html`
插件 UI：

- 粘贴或载入 `structure.json`
- 可选粘贴 `report.json`
- 预览章节
- 选择要重建的 sections
- 选择插入到新页面或当前页面

## SVG 约定

当前默认使用**带画板的 SVG 导出**，也就是 SVG 自带完整 `viewBox` / artboard 坐标。

这样做的好处是：

- section 顺序更稳定
- 位置还原更稳定
- 宽高和整体页面关系更清楚

建议素材尽量满足：

- 每个章节是一个独立 `<g>`
- 章节名可匹配 `section_notice_001` 这类命名
- 背景层命名为 `background`
- 标题层命名为 `title`
- 正文层命名为 `body`
- 文本保留为 `<text>/<tspan>`，不要转 outlines/path

## 生成结构文件

在项目目录运行：

```bash
python3 generate_structure.py \
  --svg ./test-board.svg \
  --config ./generator.config.json \
  --out ./out
```

生成后会得到：

- `out/structure.json`
- `out/report.json`

## 在 Figma 中使用

### 1. 加载插件
在 Figma 里以开发插件方式加载本目录，入口文件：

- `manifest.json`

### 2. 导入结构数据
插件打开后可以：

- 直接载入内置 sample
- 或粘贴自己的 `structure.json`
- 可选再粘贴 `report.json`

### 3. 选择重建范围
可选择：

- 重建全部 section
- 只重建部分 section
- 插入到新页面
- 或插入到当前页面

## 当前实现特征

### 1. 重建按绝对坐标进行
不是简单 Auto Layout 近似，而是：

- 先创建 artboard 容器
- 每个 `Section/<id>` 按 `frame.x / frame.y` 放置
- 标题和正文按各自几何定位

### 2. 背景会跟正文变高
当正文真实渲染高度大于原始高度时：

- 当前 section 高度会被拉长
- 后续 section 会整体下推
- 画板在需要时也会增高

### 3. 这套“下推”逻辑是通用但有边界的
只要后续输入还是：

- 单列
- 纵向堆叠
- 后续 section 的位置只依赖前文高度变化

这套逻辑就可以复用。

如果以后不是线性单列排版，就需要换成更完整的布局约束模型。

## 已知限制

当前还不是完整保真导入，已知限制包括：

- 主要针对单列公告流式排版
- 字体能否完全匹配，受 Figma 当前可用字体影响
- 渐变已支持基础线性渐变，但复杂渐变仍可能有偏差
- 文本换行依赖 Figma 实际字体度量，和 SVG 原始排版可能仍有细微差异
- 目前没有直接在插件内上传 SVG 文件，仍是先离线生成 `structure.json`

## 下一步建议

- [ ] 提升重建保真度，进一步完善字体、渐变、描边、圆角与文本排版还原
- [ ] 增强 SVG 结构识别能力，覆盖更多章节命名方式与素材变体
- [ ] 强化报告与诊断能力，让 `report.json` 更清楚解释识别结果与重建状态
- [ ] 完善单列公告流的自适应重排，稳定处理正文增高、section 下推与 artboard 扩展
- [ ] 优化导入体验，提供更顺畅的载入、预览、报错与重复导入流程

## Git

当前目录已经初始化为独立 git 仓库。

`.gitignore` 已忽略：

- `__pycache__/`
- `*.pyc`
