# LuluLab CLI 视频生成

本轮未提交的所有目标分镜与 Prompt 齐备后，才运行一次整批提交。重复 `--segment-id` 列出全部未提交段，不允许只提交当前先完成的一段。脚本取得各段报价、合计核对可用积分，再通过 `/tasks/batch` 由服务端一次性冻结整批额度；不足时整批拦截。既有任务ID只复用/恢复，不重提；整批提交后再查询、下载和拼接。


固定provider为 `lululab_cli`，模型默认 `seedance-2-mini`（Seedance2 Mini）。新增模型 MiniMax H3、Wan 3、Omini 的提交枚举值分别为 `minimax-h3`、`wan-3`、`google-omni`；每段时长与分辨率按 `references/model_capabilities.md` 校验。不切换其他平台。

```text
node scripts/video_cli_preflight.mjs --manifest <manifest>
node scripts/run_generation.mjs --manifest <manifest> --video-provider lululab_cli --segment-id <ID1> --segment-id <ID2> --skip-concat --dispatch-only --generation-approved
node scripts/run_generation.mjs --manifest <manifest> --video-provider lululab_cli --max-concurrency 5
```

CLI通过 `task submit-batch --input <JSON数组>` 整批触发既有视频工作流，每项携带 `workflowId: VideoGenV2`。沿用底稿输入：`model`、`prompt`、整数 `duration`、`aspectRatio`、`resolution`、`referenceImages`。图片工作流为 `ImageGenV2`，模型为 `gpt-image-2-5-sunburst`，图片输入不含duration。

参考图片按最终Storyboard、当前任务全部已登记用户产品图、全部用户达人图及本段目标AI达人身份板的顺序上传，转换为url/mimeType/expiredAt媒体对象，不把本地路径传给服务端。是否沿用原产品或人物不取消用户上传图；有语义冲突时阻断。新任务`ai_generated`单段和多段都必须携带已验证的2×2身份板，并与Storyboard编辑使用同一文件。旧Manifest继续沿用原单段无图、多段三视图策略。提交前审计去重后的实际请求引用，超过模型上限时使用既有合规合并方案，否则明确阻断。
AI模式下还要检查最终Storyboard的`replacement.imageTaskReport`：其成功图片编辑报告必须包含当前身份图SHA256，证明同一图进入过整板编辑。报告丢失、图片改变或引用不一致时停止视频付费提交。

每段只提交一次并立即保存taskId。之后只用 `task fetch --id` 查询原任务。状态不确定、超时、失败或鉴权异常不自动重做，也不自动换平台。成功结果从output中的image/video媒体对象下载，不能误取input的参考图。

固定图片与视频工作流ID来自原附件CLI二进制，用户已确认LuluLab与原服务其他契约一致。无需客户端部署工作流；环境变量覆盖仅为高级可选项。

## 人物视觉参考优先级

保留当前参考图提交逻辑：最终替换后Storyboard排在前面，用户原始达人图继续提交（AI身份板依既有模式处理），不删除图片、不增加新的图生成步骤。**顺序不等于模型强制权重**：每段Prompt必须显式指明最终Storyboard主导已按达人图匹配的服装、发型呈现、身形、姿态和场景；用户达人图辅助身份和服装细节，忽略其背景与站姿。对同一人物跨Segment重复一致的服装特征。参照 `references/local_prompt_pipeline.md`。
