# 单一Storyboard的清理与替换

图片固定通过 LuluLab CLI 的 `ImageGenV2`，模型 `gpt-image-2-5-sunburst`、1K，使用 `scripts/lululab_image_generate.py`。不使用原生图片工具或切换其他通道。Planner V1/V2每段为3×3、9个anchors；抽帧图只是暂存，最终只保留一张rawStoryboard/edited Storyboard。

## 默认快速路径

1. 依据蓝图visibleText决定是否去字，并将去字和产品/达人替换合并到一次LuluLab CLI图片编辑。
2. 只生成一次整板候选图；不做视觉质检，不因质量问题自动重做。
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
