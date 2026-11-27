# LuluLab Video Recreation / 视频复刻

Use an agent to enter the same settings and submit the same Customer/Dispatcher parent tasks as the website. / 在智能体里录入网站同款配置，提交相同的服务端父任务。

- Deep / 动作模仿：`DeepRecreationV1`, pipeline 2, presentation 1。
- Storyboard / 分镜复刻：`StoryboardRecreationV1`, pipeline 2。
- Element replacement / 元素替换：`ElementReplacementV1`。

先收集参考视频、复刻模式和必要的替换信息。沿用用户已指定的设置，其余用默认值，和积分预估一起确认。

Requires Node.js 20+, local LuluLab credentials and FFprobe to measure source duration. Copy the complete skill folder into the agent skills directory. Set `LULULAB_API_KEY` locally or use the existing private configuration; never put keys in arguments, prompts or task state.

Run `node scripts/dispatcher_recreate.mjs --help`. Once the essential inputs are available, prepare the request, run offline `plan`, and query `estimate`. Present the settings and credit estimate together, then submit once with the approved credit limit. Resume the original state with `poll` and `download`. An uncertain or failed paid task requires the recovery steps in SKILL.md.

See [SKILL.md](SKILL.md) and [Dispatcher contract](references/DISPATCHER_RECREATION.md). Legacy scripts are only for existing local manifests or explicit prompt-only/old-pipeline requests; see [legacy recovery](references/LEGACY_LOCAL_RECREATION.md).

Interaction language follows the user; output language is independent. / 交互语言跟随用户，成品语言单独配置。
