# 单一Storyboard的清理与替换

图片固定通过 LuluLab CLI 的 `ImageGenV2`，模型 `gpt-image-2-5-sunburst`、1K，使用 `scripts/lululab_image_generate.py`。不使用原生图片工具或切换其他通道。Planner V1/V2每段为3×3、9个anchors；抽帧图只是暂存，最终只保留一张rawStoryboard/edited Storyboard。

## 默认快速路径

1. 依据蓝图visibleText识别原片口播字幕、商品说明、价格/促销贴字及无关UI；记录值得保留的文字区域、样式和时段供后期重建。整板编辑中去除原片烘焙文字，并将去字和产品/达人替换合并到一次LuluLab CLI图片编辑；不复制未核实价格。
2. 只生成一次整板候选图；不做视觉质检，不因质量问题自动重做。多个 Segment 的整板候选图使用各自独立的 report、output 和锁文件，全部输入就绪后最多5段并发提交、查询；不可因某段正在等待就推迟其他段。已有 taskId 的段只恢复原任务，不重提。
3. 不建Replacement Map，不运行`validate-map`、`preview-mask`或`lock-merge`。
4. 运行：
```text
python3 scripts/storyboard_cells.py fast-prepare --original <rawStoryboard> --edited <candidate> --output <finalStoryboard>
```
5. `fast-prepare`只执行机械门禁：文件可读、比例偏移不超过15%、3×3网格可识别、恢复原时间标签与原输出尺寸。
6. 用`method=whole-board-fast-v1`、`validationLevel=mechanical`登记edited。`replacementVerified`只是文件、SHA、布局和引用完整性，不是视觉质量声明。

## 显式严格路径

只有用户明确说“严格复刻”或要求逐像素保护时使用：建立`object-regions-v1` Replacement Map，运行`validate-map`和`lock-merge`，要求`protectedPixelsRestored=true`且`outsideMaskChangedPixels=0`，最后执行一次视觉质检。区域冲突时停止，不扩大mask绕过protect。

最终板复用原9个anchors。每个personPresent=true的anchor必须写完creatorIds。原片帧不得直接登记为Creator图。新任务默认AI达人模式：完成主要人物映射后，先使用 `creator_identity.py` 生成并登记一张2×2身份板（特写、正面、侧面、背面），再用它编辑相关Storyboard；单Segment也适用。多Segment同一creatorId共用身份板。用户明确选择`keep_source`时不生成身份板，选择`user_provided`时用用户图。缺失`creator.mode`的旧Manifest延续原多Segment三视图、单Segment无额外身份图的方案。
V7在编辑前按entity_bindings.md登记轻量replacementBindings，并将每格的来源人物/产品与目标映射传入图片编辑指令。它不是像素Replacement Map；fast仍不做编辑后视觉质检。原片核对在首次编辑前的分镜理解步骤完成，有疑问才补看相关原片帧。AI身份板由同一LuluLab图片通道生成，只做一次必要的结构与无产品检查，不增加第二次视觉模型调用。
AI模式的整板编辑必须通过 `lululab_image_generate.py --reference-image <identity-sheet>` 引入本段对应身份图；将该图片编辑任务的报告绝对路径写入edited Storyboard的`replacement.imageTaskReport`。报告会保存提交时各参考图的SHA256；视频付费提交前校验它包含当前目标身份板。Storyboard最终板继续按原Fast/Strict流程准备，不新增视觉模型调用。


## 人物替换硬规则：整人替换（适用于 user_provided / ai_generated）

当 replacementBindings 指示替换某来源人物时，单次整板图片编辑必须将该来源人物在每个相关格子中的**完整可见人物外观**替换为同一目标达人，**不是换脸、贴脸或仅修改头部**。目标身份以已登记的用户达人图（`user_provided`）或 AI 身份板（`ai_generated`）为依据；姿势、走位和道具遮挡以 raw Storyboard 为依据。具体要求：

- **完整身份替换**：统一目标达人的面部、发型、肤色、体型、肩颈比例、身体可见部分、整体气质；同一 creatorId 在同一九宫格及跨 Segment 使用同一身份外观，不把原人物脸与目标人物身体拼接。
- **服装一套锁定**：`user_provided` 模式下，默认严格匹配用户达人图的上衣、下装、颜色、图案、鞋履及可见配饰；用户明确指定另一套服装时以明确指令为准。`ai_generated` 模式匹配已登记身份板的服装；`keep_source` 模式保留原片服装。九格及跨段保持同一套。人物姿势、坐姿、表情变化和手持关系仍来自原Storyboard，不把原人物的服装当成受保护像素。
- **同时锁定内容**：保持九格顺序、构图、镜头距离、背景、光影、产品数量/品牌/包装、动作时间顺序、手部与商品遮挡关系；保留合理的自然变化。不能误替换未映射人物，也不能统一不同 creatorId。
- **输入与输出**：图片编辑阶段为原始九宫格 + 目标达人参考图 + 需要替换的产品图，输出一张完整的3×3目标分镜。目标达人图负责身份及服装，原始九宫格负责姿势、场景、镜头和产品持有关系；视频阶段仍提交原始用户达人图。

向 `lululab_image_generate.py` 提交的图片编辑提示词必须明确写出如下优先规则（按交互语言翻译，不得漏掉服装规则）：

```text
将九宫格中指定的来源人物整体替换成同一位目标达人，绝非仅换脸。同步替换脸部、发型、肤色、体型、肩颈及所有可见身体外观。用户提供达人图时，服装严格匹配达人图中的上衣款式、领口、袖口、下装、颜色、图案及可见配饰；用户明确指定另一套服装时以其指令为准。不要保留原片人物的服装。九格及跨段保持同一套。保留原片镜头构图、姿态、手势、表情变化、背景、产品数量及遮挡关系。不同 creatorId 不合并。输出仍为完整3×3九宫格。
```

快速路径仍只编辑一次、不新增视觉模型质检或自动重新生成。`replacementVerified` 仍只代表机械校验通过；不能声明完整人物替换已被视觉验证。
