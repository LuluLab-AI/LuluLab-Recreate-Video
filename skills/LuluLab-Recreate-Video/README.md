# LuluLab Video Recreation / 视频复刻

Use an agent to enter the same settings and submit the same Customer/Dispatcher parent tasks as the website. / 在智能体里录入网站同款配置，提交相同的服务端父任务。

- Deep / 动作模仿（Skill 默认）：`DeepRecreationV1`, pipeline 2, presentation 1。
- Storyboard / 分镜复刻：`StoryboardRecreationV1`, pipeline 2。
- Element replacement / 元素替换：`ElementReplacementV1`。

分镜复刻和动作模仿默认 Seedance 2.5 Flash、480p、9:16。两个模式都支持 AI 新人物、上传指定人物和沿用原片人物，默认 AI 新人物。分镜复刻默认 AI 生成声音，可静音。动作模仿默认保留原片声音，也可选择 AI 生成声音或静音。

Requires Node.js 20+, local LuluLab credentials and FFprobe to measure source duration. Copy the complete skill folder into the agent skills directory. Set `LULULAB_API_KEY` locally or use the existing private configuration; never put keys in arguments, prompts or task state.

Run `node scripts/dispatcher_recreate.mjs --help`. Prepare input and run offline `plan`, query `estimate`, present the settings and credit estimate together, and submit once with the approved credit limit. Resume the original state with `poll` and `download`; never resubmit an uncertain or failed paid task automatically.

See [SKILL.md](SKILL.md) and [Dispatcher contract](references/DISPATCHER_RECREATION.md). Legacy scripts are only for existing local manifests or explicit prompt-only/old-pipeline requests; see [legacy recovery](references/LEGACY_LOCAL_RECREATION.md).

Interaction language follows the user; output language is independent. / 交互语言跟随用户，成品语言单独配置。
