# LuluLab CLI 视频生成

固定provider为 `lululab_cli`，模型默认 `seedance-2-mini`（Seedance2 Mini），720p、每段4–15秒，不切换其他平台。

```text
python3 scripts/video_cli_preflight.py --manifest <manifest>
python3 scripts/run_generation.py --manifest <manifest> --video-provider lululab_cli --generation-approved
```

CLI通过 `task submit --workflow-id VideoGenV2 --input <JSON>` 自动触发既有视频工作流。沿用原灵智CLI输入：`model`、`prompt`、整数 `duration`、`aspectRatio`、`resolution`、`referenceImages`。图片工作流为 `ImageGenV2`，模型为 `gpt-image-2-5-sunburst`，图片输入不含duration。

参考图片按最终Storyboard、当前任务全部已登记用户产品图、全部用户达人图及本段目标AI达人身份板的顺序上传，转换为url/mimeType/expiredAt媒体对象，不把本地路径传给服务端。是否沿用原产品或人物不取消用户上传图；有语义冲突时阻断。新任务`ai_generated`单段和多段都必须携带已验证的2×2身份板，并与Storyboard编辑使用同一文件。旧Manifest继续沿用原单段无图、多段三视图策略。提交前审计去重后的实际请求引用，超过模型上限时使用既有合规合并方案，否则明确阻断。
AI模式下还要检查最终Storyboard的`replacement.imageTaskReport`：其成功图片编辑报告必须包含当前身份图SHA256，证明同一图进入过整板编辑。报告丢失、图片改变或引用不一致时停止视频付费提交。

每段只提交一次并立即保存taskId。之后只用 `task fetch --id` 查询原任务。状态不确定、超时、失败或鉴权异常不自动重做，也不自动换平台。成功结果从output中的image/video媒体对象下载，不能误取input的参考图。

固定图片与视频工作流ID来自原附件CLI二进制，用户已确认LuluLab与原服务其他契约一致。无需客户端部署工作流；环境变量覆盖仅为高级可选项。
