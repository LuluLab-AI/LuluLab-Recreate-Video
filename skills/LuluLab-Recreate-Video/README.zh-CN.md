# LuluLab Video Recreation / 视频复刻

Use an agent to enter the same settings and submit the same Customer/Dispatcher parent tasks as the website. / 在智能体里录入网站同款配置，提交相同的服务端父任务。

- Deep / 深度复刻（默认）：`DeepRecreationV1`, pipeline 2, presentation 1。
- Storyboard / 分镜复刻：`StoryboardRecreationV1`, pipeline 2。
- Element replacement / 元素替换：`ElementReplacementV1`。

默认 Fast、720p、9:16、生成声音；元素替换默认 Seedance 2.5。分镜和深度复刻支持 AI 新人物、指定人物、原片人物，未选且未上传人物图时默认 AI 新人物，与网站一致。服务端负责拆解、人物参考、视频生成与合成，客户端只上传、预估、提交、查询和下载。

Requires Node.js 20+, local LuluLab credentials and FFprobe to measure source duration. Copy the complete skill folder into the agent skills directory. Set `LULULAB_API_KEY` locally or use the existing private configuration; never put keys in arguments, prompts or task state.

Run `node scripts/dispatcher_recreate.mjs --help`. Prepare input and run offline `plan`, query `estimate`, display the complete configuration and estimated credits, then submit once after explicit approval. Resume the original state with `poll` and `download`; never resubmit an uncertain or failed paid task automatically.

See [SKILL.md](SKILL.md) and [Dispatcher contract](references/DISPATCHER_RECREATION.md). Legacy scripts are only for existing local manifests or explicit prompt-only/old-pipeline requests; see [legacy recovery](references/LEGACY_LOCAL_RECREATION.md).

Interaction language follows the user; output language is independent. / 交互语言跟随用户，成品语言单独配置。
