# Storyboard抽取

生产入口为`scripts/blueprint_timeline.py`，客户端只消费服务端`replicationPlan`。服务端协议不返回layout；适配层根据anchors数量派生本地布局。当前Planner V1策略为每Segment 9个anchors，因此`storyboard.py`生成3×3板。完整镜头动态仍由videoBlueprint承担，Storyboard只负责关键静态视觉。

默认Fast不为代表帧或最终Storyboard另做AI视觉质检；抽帧成功、9格完整、时间范围合法由代码验证。Full/strict按现有规则处理。批量抽帧使用 `--stream-ready` 逐段输出独立metadata；收到一段就登记并交接编辑，不等待其余段。
