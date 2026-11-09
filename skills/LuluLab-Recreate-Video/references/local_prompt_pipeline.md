# V7最终Prompt（兼容旧任务）

各段目标 Storyboard 就绪后可以准备和展示对应 Prompt；保持按 Segment ID 排序。所有本轮未提交分段的分镜和 Prompt 都齐备后才进行视频提交。通过重复 `--segment-id` 列出全部待生成段，运行一次 `run_generation.mjs --skip-concat --dispatch-only --generation-approved`，由 `/tasks/batch` 整批校验和冻结。不得后段先提交、不得逐段占用积分。

等待前运行 `task_status.mjs --assert-can-wait`；仅当所有未提交段都具备 Prompt 时才出现 `dispatch_video_batch`。退出码3仍表示视频终态失败，应按原恢复规则处理。已有任务ID只恢复，不重复提交。


读取锁定Segment、target Storyboard和对应版本蓝图。用户要求最高；静态视觉以target板/身份图为准，动态与声音保留原片蓝图。用KEEP/CHANGE/AUTO-DESIGN清单防止替换身份时改变剧情、表演和动作。

V7从replication-package.json的entityContexts读取本段全部镜头及replacementBindings；Prompt的creatorIds必须等于完整镜头映射后的目标人物集合，不只写九格内或主达人。V6旧任务仍按anchors并集。Prompt开头逐个说明“保留原片身份”或“替换为目标身份”，禁止合并、互换或改变人种、性别、年龄、发色和脸部特征。如anchors中有人但无ID则停止Prompt交接。新任务`ai_generated`的目标creatorId在单段与多段均须有已登记的2×2身份板；同一ID的各段始终引用同一张图。Prompt说明原片动作和表演仍由Blueprint控制，外貌由目标身份板控制。旧Manifest缺失达人模式时沿用旧的单段无图、多段三视图规则。


## 视频参考图职责与冲突处理（所有分段共用）

**继续传入最终替换后的 target Storyboard 和用户原始达人图**；按照当前 referenceAudit 的顺序和去重规则提交。编辑目标分镜时已将人物服装与用户达人图匹配；最终分镜是视频的**主视觉基准**，锁定人物服装、发型呈现、体型、站坐姿、动作、手持商品、背景及构图。用户达人图继续校准脸部身份、自然肤质与服装细节；不得把其背景、站姿或道具带入成片。若两张图服装不一致，先修正目标分镜，再生成视频。跨 Segment 对同一 creatorId 重复完全一致的目标服装描述。

每段最终视频Prompt开头必须包含清晰的参考优先级与服装连续性指令。中文交互输出以下语义的中文，其他语言交互输出对应英文；口播/允许的字幕仍使用 targetLanguage：

```text
参考图优先级：第一张最终替换后的目标分镜图是人物整体造型与镜头画面的主参考，严格锁定同一位达人的服装款式、颜色、图案、发型、身形、姿态、背景及商品关系。用户达人图辅助确认五官、肤质和服装细节；目标分镜中的服装已与达人图一致。不得从达人图继承背景、站姿或无关道具。当前Segment以及所有后续Segment中，该达人必须保持同一套目标服装，不允许突然换装或改变款式。
```

如果用户明确指定与达人图不同的目标服装，以用户指令为准并先更新目标分镜。优先级是生成指令而非模型API的强制权重，不能保证模型百分之百遵循；保持当前一次生成流程，不新增参考图生成、付费审核、额外图片任务。

每段prompt以参考素材职责开头：一张target板锁定画面状态，产品图锁定产品；存在合规达人图时才说明其锁定外貌。不得在Prompt中把未实际提交的达人图写成参考素材。宫格时间标签仅用于定位，不能出现在成片。按真实shot局部时间逐项描述镜头，不设置宏观阶段数量上限。同镜头关键状态不虚构硬切，Segment边界不自动当切镜。

Prompt的**说明语言**仅允许中文或英文：按稳定 interactionLocale 判定（zh/zh-* → 中文，其他 → 英文），不得按 targetLanguage、原视频语言、市场国家来决定。参考素材职责、格式、风格、镜头、动作、运镜、节奏、声音、时间线说明、禁止项全部使用说明语言。**内容语言**独立：口播对白、配音原文必须采用用户指定的 targetLanguage（无指定时按既有逻辑沿用原语言），逐字保留；即使泰语口播放在中文/英文说明里，也不可改成中文/英文。shotId、beatId、utteranceId、creatorId、产品名、节点占位符与专有名词原样保留。视频Prompt的禁字要求只针对模型生成画面；拼接后按 caption_postproduction.md 添加目标语言字幕和已核实营销文案。

明确起始状态→动作→结束状态、眼神、反应、停顿、情绪变化、节奏和切镜。完整保留cutPlan和dramaticBeats，未入宫格的镜头也必须写。对白逐句包含utteranceId、speakerId、局部时间、原文、情绪强度、是否出镜及lipSync。跨段保持同一Voice Setting；不得默认女性画外音、关闭BGM或将去字幕误为去人声。

跨Segment对白用同一lineId关联，按蓝图实际时间分配，不重复整句；若蓝图不足以准确分配文本则停止报告，不能猜词或自动重拆。各段另存shotIds、beatIds、utteranceIds便于覆盖校验。

输出videoPrompts.segments，每段含segmentId/title/duration/globalStart/globalEnd/storyboardIds/creatorIds/productPresent/shotIds/beatIds/utteranceIds/prompt。local=global-globalStart，只转换一次；窗口和板ID不得改变。

视频模型不得生成烘焙字幕、价格贴纸、促销字或无关UI；原片的文字位置、出现时间和视觉作用记录下来，按 caption_postproduction.md 在拼接成片后以独立字幕层重建。即使用户已提供价格，也不要让视频模型直接绘制文字。声音时间轴不得生成可见文字。按 prompt_display_format.md 的交互语言规则展示并导出每段完整 prompt。

结构化绑定可降低串声风险，不保证生成模型百分之百遵守；本版不新增音频参考、TTS或后期配音。
V7每段使用完整镜头productIds决定productPresent，图片编辑只按replacementBindings中实际替换的产品选图；视频生成另外提交全部用户上传产品图和达人图。原始对白保留在蓝图；目标语言对白仍逐条关联utteranceId/lineId。指令、描述使用中文(zh locale)或英文(其他locale)，对白/允许的字幕仍使用目标视频语言；交互语言遵循 SKILL.md 的 明确可获取的宿主语言设置优先规则，不按消息文字或操作系统语言重新检测。最终Prompt明确角色对应镜头、动作与产品持有者；不得把镜头人物并集解释为每一帧同时出现。
