---
name: recreate-video-agent
description: Recreate authorized commerce videos with LuluLab CLI across file-based Agent Skills hosts. Keep interaction language independent of target video language.
license: Apache-2.0
metadata:
  skillhub:
    slug: recreate-video-agent
    version: 1.3.0
    displayName: Recreate High-Performing Videos / 复刻爆款视频
    summary: Recreate commerce videos with multilingual replies across capable agents.
    tags:
      - 视频复刻
      - 爆款视频
      - 电商广告
      - AI视频
    homepage: https://github.com/LuluLab-AI/LuluLab-Recreate-Video
---

# recreate-video-agent v1.3.0

## Response language

Resolve the interaction language before the first user-facing message, including the skill-use announcement. Use this precedence:

1. The user's explicit request for the response language.
2. The response language explicitly available from the current host's instructions/settings (including Codex's configured response language), or explicitly reported by the user.
3. The interaction locale already saved for this task or established in the conversation.
4. English when no preference is available.

Keep this selection stable across turns, numeric confirmations, attachments, resumed tasks, and tool calls. A message written in another language is not an explicit request to switch. Never infer the interaction language from filenames, file contents, the source video, target video language, OS/terminal locale, or the language of this skill. If the host does not expose its setting, do not claim to have read it, scan unrelated configuration, or guess from the OS; use the remaining precedence rules. An explicit user request or a newly supplied host response-language setting can update the saved selection.

Apply the selected language to every user-facing announcement, heading, confirmation field and option, progress update, permission explanation, error/recovery message, report summary, link label, and final response. Translate instructions cited from SKILL.md and references into that language; link the original instead of inserting an untranslated quote. Tool output and Chinese examples are diagnostic/source material, not text to copy into chat. Translate their meaning while preserving task IDs, commands, names, and paths when necessary. Render templates in the selected language, even when only English and Chinese examples are provided. Check each message before sending for unintended language switches.

Pass the selected locale explicitly at initialization with `--interaction-locale <locale>` (for example `en`, `zh-CN`, `fr`, or `pt-BR`). Scripts cannot read the host app's language setting. `--codex-locale <locale>` remains an optional explicit handoff for Codex compatibility, not automatic detection. Claude Code and WorkBuddy may supply an explicit host language setting in the same way; otherwise use the saved task language or English. On resume, retain the saved locale unless an explicit user language request or current host setting supersedes it; update it with `generation_manifest.py set-interaction-locale --manifest <manifest> --interaction-locale <locale>`. Locale state must not change targetLanguage, source facts, prompts, task IDs, or generation authorization.

The target video language is independent and keeps its existing user-selected/source-language behavior. Exact source dialogue, filenames, and generation prompts may need another language as task data; they do not change the chat language. When a registered prompt differs from the interaction language, export its unchanged text and provide a localized summary and file link by default. Only display the complete other-language prompt inline when the user explicitly requests it, clearly labeling its target language. Follow references/prompt_display_format.md for the applicable display path.

## Task completion and recovery

A pending server state such as Created or Running is progress, not a workflow failure. After dispatch, retain the returned process/session ID and keep waiting on that execution while sending concise progress updates. Do not end the task with a final pending-status message while a live polling process remains active. Continue through successful analysis, storyboard preparation, authorized generation, and delivery; stop only on a real error/timeout, required user input, or an explicit user interruption. Preserve task IDs and never resubmit to overcome waiting.

On every resumed turn, or after a polling process was interrupted, run `python3 scripts/task_status.py --manifest <manifest>` first. If it reports `video_ready`, immediately give the user the existing final video and its saved technical status. Do not fetch, re-download, re-render, or resubmit in that case. If it reports `segments_ready`, finish local assembly; for a pending task, resume only its saved task ID. For a local source, reuse completed Gemini analysis when `analysis.cacheValid` is true; false means the source changed. Null means old or remote provenance needs manual comparison with the saved task input before reuse. Never rely on the last chat message or a past `Created`/`Running` snapshot to describe current state.

When resuming, first read the manifest and saved analysis/image/video results. Reuse a stage only when its input fingerprint and output files still match; changes to source video, user references, bindings, model, locale or prompts invalidate dependent stages. Fetch/resume the existing ID only when the result is not yet available. Report current saved state rather than an earlier chat snapshot. Check the bundled Node CLI before asking the user to install anything.

## Host capability check

This single file-based Skill works in Codex, Claude Code, and WorkBuddy only when the host can read and write files and run commands. Before processing, run `python3 scripts/host_preflight.py` from the Skill root. It checks Python 3.9+, Node.js 20+, FFmpeg/FFprobe, file read/write, and bundled CLI execution. If any check fails, report its exact missing capability and stop dependent work. Do not assume WorkBuddy has every capability. Keep the same SKILL.md and scripts for all hosts.

## 技能概述

本技能用于将已授权的爆款带货视频复刻为新的商业视频。它会分析原片的镜头结构、人物动作、运镜、口播、声音和营销节奏，按分段生成真实帧分镜，并按需替换商品、达人、语言及目标市场内容。完成分镜和提示词确认后，技能会通过LuluLab CLI生成、拼接并交付成片。

## LuluLab CLI 固定生成通道（1.1.5）

本版沿用原灵智CLI的既有工作流与输入协议，仅替换为LuluLab CLI：拆解 `RecreateVideoPromptV3`，图片 `ImageGenV2`，视频 `VideoGenV2`。工作流由CLI自动触发，客户端不导入、部署或编排服务端工作流。

- 图片生成和编辑一律使用 `scripts/lululab_image_generate.py`，模型固定 `gpt-image-2-5-sunburst`，分辨率1K。原生图片工具和其他图片平台不参与本流程。
- 视频一律使用 LuluLab CLI，默认 `seedance-2-mini`（Seedance2 Mini）、720p。不自动切换LibTV、小云雀、即梦或其他平台。
- 通用命令：`lululab task submit --workflow-id <ID> --input <JSON>`；取得ID后用 `task fetch --id <ID>` 恢复。所有参考图先使用 `upload` 上传为媒体对象；顺序为最终Storyboard、用户上传的产品图、用户上传的达人图。沿用原片的选择不取消上传素材的登记与提交。
- 工作流ID内置；`LULULAB_IMAGE_WORKFLOW_ID`、`LULULAB_VIDEO_WORKFLOW_ID`仅为可选高级覆盖项，不要求用户配置。
- Seedance2 Mini每段4–15秒；既有11秒和9秒规划可继续使用。不要为了切换到Mini再次付费拆解。
- CLI不可用、鉴权失败、任务失败或超时时，保留已有任务和素材，报告具体原因，不绕过固定通道或自动重做。
- 图片和视频均使用排他进程锁。提交前持久化submit_pending，响应不确定时禁止重提；已有taskId在查询超时或下载失败后只恢复原任务。服务端明确终态失败时停止，重生成须另行授权。
- 其余一次启动确认、拆解最多两次提交、来源绑定、预处理和任务恢复规则保留。用户已确认的生成配置适用于本次LuluLab图片和视频生成；后续模型调整按用户当前要求执行。

## 0. LuluLab API Key 按需门禁（仅在首次服务端拆解前）

复刻任务开始时不得检查、索取或提醒用户配置LuluLab API Key，也不得把 Key、登录或授权状态加入启动确认单。先正常读取原视频、展示启动确认、初始化manifest并完成本地技术分析。只有流程即将首次执行第2节、调用`RecreateVideoPromptV3`进行服务端拆解时，才运行下面的零消耗远端鉴权预检：

```text
python3 scripts/lululab_key_preflight.py
```

预检会从`LULULAB_API_KEY`或`~/.recreate-video-lululab/config.json`的`apiKey`读取非空 Key，并调用LuluLab`user --credits`完成真实服务端鉴权。只有命令返回`{"ok": true, "authenticated": true}`才算通过；“本地存在非空 Key”、CLI 可启动或未经证实的网络错误都不算通过。

- 未配置 Key 时，只在这个按需检查节点提醒用户：“接下来需要调用LuluLab拆解原视频，请前往 https://customer.lululab.ai/ 获取 API Key。”不得把这条提醒提前到任务开始、素材检查或启动确认阶段。
- 远端预检因 Key 无效、权限不足、网络失败、CLI 不可用等原因未通过时，停止即将进行的LuluLab拆解，保留已经完成的本地分析和manifest；只展示脱敏原因，请用户检查或更换 Key 后重试。
- 预检通过前不得上传原视频或提交LuluLab任务。每个新任务在首次LuluLab调用前都必须完成一次预检，不得因为之前任务曾通过而跳过；预检之前的本地读取、确认、初始化与技术分析不受此门禁限制。
- 如果用户提供 Key，只将其用于本地配置和鉴权；不在后续聊天、命令输出、日志、manifest或交付物中回显完整 Key。
- 本机已配置 Key 时不提示、不重复索取，直接在按需检查节点执行远端预检。预检只证明当前 Key 可被LuluLab服务鉴权，不把余额数值写入日志、manifest或交付物。

## 职责与授权

用户要求优先。使用最少Segment，每段唯一rawStoryboard。当前Planner V2策略输出9个anchors；Storyboard布局由客户端根据anchors数量派生，不作为服务端协议字段。原视频决定动态和声音，target Storyboard决定替换后的静态视觉。新任务默认`storyboardValidationMode=fast`；只有用户明确说“严格复刻”或要求区域锁定时才使用`strict`。旧Manifest缺少该字段时按`strict`处理。不要将用户人物微调要求推广为所有任务的默认要求。

沿用 references/start_confirmation_format.md 的一次启动确认，字段为产品、达人、模型、时长、国家、语言及其他要求。确认问题必须提供数字选项，让用户只回复`1`即可按当前配置开始，回复`2`则进入配置修改。确认开始授权本轮原视频上传、服务端拆解最多两次提交（首次明确终态失败时自动重试一次）、图片编辑及通过LuluLab CLI进行的首次视频生成。除这一次服务端拆解自动重试外，失败或质量不合格不自动授权其他付费重试。默认Seedance 2 Mini、原时长、原国家语言、原人物产品。逻辑模型与时长能力仍由 scripts/model_capabilities.py 决定。

图片生成与编辑固定通过LuluLab CLI的ImageGenV2；服务端拆解通过RecreateVideoPromptV3；视频通过VideoGenV2。鉴权仍延迟至首次服务端调用前，密钥不在聊天或交付物中展示。客户端不导出音频、不运行ASR、不做TTS。

人物ID仍是Prompt语义绑定的硬门禁，但达人参考图按来源和Segment数量决定。绝不把原视频抽取的单帧登记或提交为达人参考图。用户提供达人图时直接使用用户图；用户未提供时，多Segment任务必须按上述图片路由生成每位持续人物的无产品多视图，单Segment任务不生成、不提交达人参考图。

## 1. 预检与初始化

随 Skill 提供的 Node.js CLI 位于 `scripts/lululab_cli.mjs`，需要 Node.js 20+；`server_video_analysis.py`依次检查显式 `--cli`、`LULULAB_CLI` 和该随包入口，覆盖值必须为 `.mjs`。不需要安装独立二进制或修改系统 PATH。

读取原文件时长（最长360秒），确认后运行generation_manifest.py init、benchmark_analysis.py和set-benchmark-analysis。源视频保持不变。技术分析阶段只产生媒体信息与technicalCutCandidates；最终Segment与Storyboard锚点由服务端确定，此时不抽板、不在客户端计算最终分段。原时长模式按视频模型要求取最近整数秒；当整数目标与真实媒体时长差值不超过0.5秒时，这是正常归一化，不得作为异常、阻塞或要求用户确认。

用户选择替换产品时，`init`后必须立即把每张用户产品图登记为独立生成输入，不得只复制到任务目录、写进Prompt或画进Storyboard：
```text
python3 scripts/generation_manifest.py set-product-references --manifest <manifest> --image <product-image> [--image <product-image-2>]
```
替换产品时，该命令把`product.useBenchmarkProduct`设为false并保存`product.productImages`。如用户上传了产品图但要求沿用原产品，使用 `generation_manifest.py register-product-uploads --manifest <manifest> --image <image> --preserve-original` 独立登记，并先确认图片确实代表原产品；不得擅自改变替换策略。没有明确一致性时阻断生成并说明冲突。所有上传的产品图和达人图都应跨段进入视频参考图，不因沿用选项消失；图片编辑仍按替换策略使用素材。

## 2. Gemini先拆解

完整读取 references/server_video_analysis.md。执行：
```text
python3 scripts/server_video_analysis.py --manifest <manifest> --benchmark <video>
```
用户明确提供可访问的HTTP(S)原视频直链并要求跳过上传时，仍保留本地原片用于技术分析、Storyboard和成片对齐，但服务端提交改用：
```text
python3 scripts/server_video_analysis.py --manifest <manifest> --benchmark <local-video> --benchmark-url <video-url>
```
`--benchmark-url`必须经过安全下载及同样的预处理和校验；无需裁剪、无需压缩且确认为MP4时才沿用原URL，需要裁剪时必须上传裁剪后的文件。不放宽启动确认、最多两次提交、时间轴校验或失败重试规则。
上传实际分析区间的视频；新任务请求携带`plannerVersion=2`（旧任务保留V1），userConfig附technicalCutCandidates、targetDuration、sourceDuration、targetDurationSource和blueprintSchemaVersion=7.0；服务端任务默认每5秒查询一次状态，避免任务已完成仍等待20秒轮询间隔；其中sourceDuration/targetDurationSource仅供服务端Code节点做确定性规划，不注入Gemini Prompt；不传rawStoryboards，不要求预先生成图片。工作流由 LuluLab CLI 自动触发，客户端不处理工作流配置。

视频预处理顺序为读取原始真实时长→判断分析区间→精确裁剪→按需压缩→校验→上传。`durationMode=custom`沿用前N秒协议，优先使用`requestedDuration`，兼容旧任务的`duration`；N大于原片真实时长时明确报错。`source`分析完整原片，不按最终生成时长的最近整数秒裁剪。裁剪使用FFmpeg从0秒同步转码视频和音频为H.264/AAC MP4；无音轨时不创建音轨。独立临时任务目录在同步上传后清理，不覆盖原片。裁剪后未超过既有20,000,000字节限制时不重复编码，超过时沿用压缩策略。上传前ffprobe及完整解码校验真实时长（允许帧精度误差）、画面方向/比例和音轨，失败禁止上传或submit。`sourceDuration`始终为原始真实时长，`targetDuration`保持原协议；`analysisDuration`只保存到本地analysis，不新增Webhook字段。候选切点只保留在实际分析范围内。

直链仅允许无凭据HTTP/HTTPS，每次重定向检查公共IP并固定连接已校验IP；阻止本地、内网和云元数据地址。最多3次重定向、512,000,000字节下载上限、120秒总下载时限、15秒单次网络/DNS时限；这些下载保护不改变20,000,000字节上传限制。直链即使无需裁剪也先安全下载校验，不凭本地原片或旧manifest推断远端真实时长。

同一manifest排他锁、上传前preparing_submission、每次taskId原子receipt必须保留。首次任务只有在服务端明确返回`failed/failure/error/cancelled/timeout`终态时才自动重提一次；第二次失败立即停止。鉴权/余额异常、CLI异常、客户端轮询超时、未知状态或提交结果不确定均不自动重提。后台session_id继续使用同一执行会话；functions cell与进程session不可混用。无输出/无exit code/无taskId不代表未提交。已有ID只用--resume-task-id恢复最新任务。旧蓝图仍可查看，不自动迁移或额外付费重拆。

## 3. 读取服务端复刻规划

RecreateVideoPromptV3在完成Gemini拆解后，由同一n8n工作流中的纯Code节点生成`replicationPlan`。该节点不调用任何大模型、不增加Token消耗，负责Segment与Storyboard anchors规划。服务端契约从本版起固定为`replicationPlan.schemaVersion=1.0`、新任务`plannerVersion=2`，旧任务兼容`plannerVersion=1`；Planner Engine与Policy分离。客户端不得重新计算、评分或修改规划规则。

执行：
```text
python3 scripts/blueprint_timeline.py --manifest <manifest> --output <task>/analysis/segment-anchors.json
```
该脚本只做协议适配：校验`replicationPlan`的schema/planner版本，把服务端结果写入既有`segment-anchors.json`兼容路径，并根据anchors数量派生本地Storyboard布局；本地不包含动态规划、切镜/对白停顿评分或keyframe锚点选择算法。

Planner V2沿用V1分段引擎与时长规则：最少Segment、整数秒模型限制、优先靠近真实cut/对白停顿、尽量不切断对白；当前V1 Policy使用9个anchors，优先使用Gemini keyframes并补足时间覆盖。V1内只允许兼容性参数调优；改变已发布模型的合法时长范围、anchor数量或协议字段必须新增Planner版本，不能覆盖V1。真实媒体时长与整数目标差异不超过0.5秒时，服务端钳制原片抽帧到`sourceDuration-0.04s`以内；超过0.5秒则规划失败。服务端返回`blueprintWarnings`和`unresolvedCuts`仅供复核，不触发再次付费拆解。

## 4. 生成唯一rawStoryboard

执行storyboard.py，传--video、--timestamps-file、--output-dir、--model（`--timestamps-file`既接受9个anchor对象的JSON，也接受每行一个时间戳的纯文本，不要再为格式往返试探）。当前Planner V2返回9个anchors，因此每段生成一张3×3 Storyboard；客户端不读取服务端layout字段，而是从anchors数量派生布局。抽帧成功、9格齐全、时间戳位于Segment窗口内由程序硬校验；不再为了模糊、闭眼、遮挡等逐阶段单独调用视觉质检。起点保持Segment开始状态。因最近整数秒取整而多出的尾部只延续或定格原片最后可观察状态，不得凭空新增镜头、动作、对白或剧情；这类不超过0.5秒的尾部补齐静默处理，无需向用户报警。

抽板后、首次图片编辑前，完整读取 references/entity_bindings.md。在原有分镜理解步骤对照原始九格与蓝图核对关键人物/产品，仅有具体疑问时补看相关原片帧；保存来源人物/产品到目标的 replacementBindings。不能把说话人当成人物清单，也不能把所有人物替换为同一达人。此来源核对不增加编辑后或视频生成后质检。

按 references/storyboard_editing.md 清理对白字幕、双语字幕及手机UI，仅保留确有剧情作用的金额特效。需要编辑时通过LuluLab CLI把去字和产品/达人替换合并到一次整板编辑；未替换且没有字幕/UI时原板直接进行机械准备，不进行无必要重绘。运行：
```text
python3 scripts/lululab_image_generate.py --prompt-file <prompt.txt> --reference-image <reference.png> --aspect-ratio <ratio> --output <output.png> --report <report.json>
```
纯文生图省略参考图参数，多图重复传参。取得taskId后仅用 `--resume-task-id` 恢复同一任务。
快速模式不做Storyboard视觉质检或自动重做；严格模式仍执行最终视觉质检。抽帧结果为处理暂存，最终板登记为storyboards.original/edited；不建立额外故事板类别。自动重试不默认授权。

清理完成后用generation_manifest.py add-storyboards-from-metadata登记。图片替换阶段沿用这张板，按KEEP/CHANGE/AUTO-DESIGN清单只修改用户指定人物或产品。人物在各段适度改形象但保持同一身份设定（仅用户提出此要求时）。

快速模式只生成一次整板候选图；不建Replacement Map，不运行`validate-map`、`lock-merge`、mask预览或视觉质检，不因残留、畸形或人物漂移自动重做。立即运行：
```text
python3 scripts/storyboard_cells.py fast-prepare --original <rawStoryboard> --edited <candidate> --output <finalStoryboard>
```
`fast-prepare`只检查文件可读、候选画布比例偏移不超过15%、3×3网格可识别，并恢复原始时间标签和输出尺寸。以`method=whole-board-fast-v1`、`validationLevel=mechanical`登记edited；`replacementVerified`只表示文件、SHA、布局和引用完整，不表示视觉质量合格。

严格模式才建立`mergeMode=object-regions-v1` Replacement Map，运行`validate-map`和`lock-merge`，要求`protectedPixelsRestored=true`、`outsideMaskChangedPixels=0`，并完成一次最终视觉质检。区域冲突时停止，不扩大mask绕过保护。

登记edited时复用同一9个anchors，布局固定3×3。对每格实际可见人物建立身份清单并把全部ID写回anchors；原视频画面只能用于人物理解和生成多视图时的内部视觉依据，不得把任何原片单帧复制、改名或直接登记为Creator图。

达人参考图策略在最终Segment数量锁定、来源映射确定后执行；需要人物图时先准备目标身份，再编辑相关分镜。新任务的 `creator.mode=ai_generated`，旧 Manifest 缺失该字段时延续已登记的人物方案：

- `ai_generated`（新任务默认）：依据既有Blueprint识别主要带货达人，将对应来源人物映射为新的目标creatorId，登记 `set-creator-mode --mode ai_generated --creator-id <id>`。不自动替换路人或把多人合并。每个目标身份只通过LuluLab `ImageGenV2` / `gpt-image-2-5-sunburst` / 1K / 1:1 提交一次任务，生成一张2×2四视图（左上特写、右上正面全身、左下侧面、右下背面）；单Segment也生成。目标国家用于穿搭和UGC风格，不推定族裔。外观须自然、真实肤质和比例，避免磨皮、影楼感、产品、道具、文字和水印。图片生成后检查画布与四视图、同一身份及无产品，再登记；不能机械确认的真实感不宣称严格验证。Storyboard替换与VideoGenV2使用同一身份图。
- `keep_source`：不生成AI达人；保留原片人物绑定。用户同时上传达人图时按身份冲突规则处理，合规图仍参与视频提交。
- `user_provided`：登记用户上传的达人图，不生成AI达人。每段视频请求仍携带当前任务全部用户上传图片。
- 缺失 `creator.mode` 的历史任务：保留原有单Segment无图、多Segment所需三视图的规则，不因版本升级重新生成。

新任务在映射人物后运行：
```text
python3 scripts/generation_manifest.py set-creator-mode --manifest <manifest> --mode ai_generated --creator-id <target-creator-id> [--profile-file <json>]
python3 scripts/creator_identity.py --manifest <manifest> --creator-id <target-creator-id>
```
生成完成、查看身份板确有同一人物四视图且无产品后运行同一脚本的 `--register-reviewed`；它不提交新任务。多段复用同一文件；中断时仅按已保存taskId恢复；失败或结构异常不自动再次付费。用户明确选其他模式时，运行 `set-creator-mode --mode keep_source|user_provided`。人物设定变化后的新候选须另行授权。
蓝图缺少结构化角色功能时可传 `--role <角色功能>`，只描述人物在原片中的职责，不把原片外貌描述作为新身份图的指令；恢复时脚本会复用已保存的角色输入。
AI达人分镜编辑时，把该身份板作为 `lululab_image_generate.py --reference-image <identity-sheet>` 的输入。登记 edited Storyboard 的 replacement metadata 时填写 `imageTaskReport: <该次图片编辑report.json绝对路径>`；提交视频前脚本核对报告中的参考图 SHA256 与已登记身份板相同。此报告属于既有一次整板编辑，不增加图片任务。

登记命令：
```text
python3 scripts/generation_manifest.py add-creator --manifest <manifest> --creator-id <id> --image <user-image> --source-type user_provided [--preserve-original]
python3 scripts/generation_manifest.py add-creator --manifest <legacy-manifest> --creator-id <id> --image <generated-sheet> --source-type generated_multiview --view front --view side_profile --view back --product-free-verified
```
当用户明确要求沿用原人物且上传对应达人图时，先核实身份一致，再用 `--preserve-original` 登记；身份不一致必须阻断并说明。此标记仅说明参考图用途，不改变 replacementBindings。
`sourceType`缺失、原片抽帧来源、生成多视图角度不全或未通过无产品检查时，Prompt交接与视频生成都必须阻断。

## 5. Prompt与生成

执行prepare_prompt_handoff.py，直接复用最终板，不重绘或拆格生成。完整读取 references/local_prompt_pipeline.md，当前智能体一次生成最终Prompt。不得固定3～5宏观阶段；完整覆盖本段shots、cuts、beats及utterances，包括未进入Storyboard的镜头。人物/产品集合来自本段全部镜头，再经replacementBindings映射；九格实际可见人物只是其中的子集。

Prompt的指令、镜头、动作、画面、运镜和声音说明使用目标视频语言；对白也使用用户指定的目标视频语言，默认沿用原语言。交互语言控制聊天和交付说明，不改变目标视频语言。指定语言与原片不同时，在最终Prompt阶段翻译并保留utteranceId/lineId关联；原片蓝图对白不改写。

保存local-video-prompts.json并用set-prompts登记（沿用该文件名以兼容现有Manifest）。登记后读取 references/prompt_display_format.md，运行 export_prompt_texts.py 导出逐段原文备份，并按其中的语言规则展示。交互语言与 Prompt 语言不同时，默认提供本地化摘要和原文链接；用户明确要求时才完整内联原文。该展示不新增中间确认门；已授权的首次生成继续执行。

完整读取 references/generation_rules.md，然后执行：

```text
python3 scripts/video_cli_preflight.py --manifest <manifest>
```

预检只检查LuluLab。`selected=lululab_cli`时执行：
```text
python3 scripts/run_generation.py --manifest <manifest> --video-provider lululab_cli --generation-approved
```
原有 ThreadPoolExecutor 保持不变；`--max-concurrency` 默认3，允许1至8。提交前先完成上传与引用审计，任务 ID 返回后立即持久化；恢复时不重新提交。相同 SHA256 媒体仅在有效时复用，缓存无有效期证明时重新校验媒体 URL。
没有可用LuluLab时保留Prompt和素材并报告CLI问题；不自动换渠道。

每个Segment只提交一次并立即保存返回的画布、节点或任务标识；之后只恢复同一任务。已开始提交后，失败、未知状态、超时、登录或余额异常都不得自动切换到下一家CLI，避免重复付费提交。首次提交必须处于本轮启动确认的授权内；任何重生成均需用户重新授权。

付费提交前必须检查`referenceAudit.segments[].orderedFiles`：顺序为最终Storyboard、全部已登记用户产品图、全部已登记用户达人图，并用 SHA256 审计最终 `referenceImages`。同一图片只上传一次；有效期内跨段复用。超上限时只使用现有可验证合并图方案，否则阻断；不得静默丢图。Replacement Map含`replaceProduct=true`时，仍须校验独立产品图和替换绑定；沿用原片时不得因此跳过用户上传图。

## 6. 核验与交付

默认使用**快速技术质检**：只读取原片与成片的媒体信息，检查时长、画面比例、音轨存在性和文件可读取性；不重新做低清视觉扫描，不生成10组原片/成片对齐图。这样不会影响已生成视频，只减少生成后的等待。

只有用户明确要求“深度质检/复刻效果评估/对齐图”时，才运行full质量模式（本地CLI路径可传`--full-quality-review`；`quality_review.py analyze`可传`--profile full`），生成切镜扫描与aligned-comparison。保留原视频路径供此时使用。technicalPassed仅代表技术指标，不能声称语义复刻成功；对白串人、乱码、反应/反转遗漏须如实报告。失败报告不隐藏已生成成片，不自动重生成。

交付本地Skill、素材及生成结果；不交付或要求导入服务端工作流JSON。
