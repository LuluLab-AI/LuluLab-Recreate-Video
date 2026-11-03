# 视频模型能力表

| 逻辑模型 | LuluLab 模型ID | 单段时长 | 分辨率 | 图片上限 |
|---|---|---:|---|---:|
| Seedance 2 Mini | `seedance-2-mini` | 4～15秒 | 720p | 9 |
| Seedance 2 Fast | `seedance-2-fast` | 4～15秒 | 720p | 9 |
| Seedance 2 | `seedance-2` | 4～15秒 | 720p | 9 |
| Seedance 2.5 | `seedance-2-5` | 4～30秒 | 720p | 9 |
| MiniMax H3 | `minimax-h3` | 5～15秒* | 720p* | 9* |
| Wan 3 | `wan-3` | 5～30秒* | 720p* | 9* |
| Omini | `google-omni` | 5～20秒* | 720p* | 9* |

以 `scripts/model_capabilities.mjs` 为本地运行时能力表。新任务保存逻辑模型ID；旧Manifest中的`seedance-2-fast-vip`和`seedance-2-vip`继续兼容读取。LuluLab 视频任务直接提交表中的逻辑ID。带 * 的新模型限制为暂定本地边界，尚需通过对应模型的服务端任务核实；服务端拒绝时保留错误，不自动换模型或重提。即梦和小云雀旧路径仍使用原有精确 provider ID 映射。
