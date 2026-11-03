# product_brief 轻量产品卡生成

仅在用户明确选择“替换为新产品”且提供产品图时使用。默认走 Fast Brief，不做重型外观复述；产品参考图本身是产品身份与外观的最高依据。

## 1. 图片校验

- `product.productImages`至少一张，接受 jpg/jpeg/png/webp/avif。
- 先检查存在、非空、去重，不上传。
- 多图明显不是同一产品时才询问用户选择；同一产品不同角度直接合并。

```text
node scripts/validate_product_images.mjs --image <product-1> [--image <product-2> ...]
```

## 2. ChatGenV2 自动识别产品图

完成产品图注册后运行：

```text
node scripts/product_image_analysis.mjs --manifest <manifest>
```

该脚本复用 `ChatGenV2`（input.prompt + images），一次识别同一产品的全部参考图，输出轻量产品卡：产品名称、类型、使用方式、锁定特征。模型**不得生成用户卖点**，用户卖点从 `manifest.product.userSellingPoints` 原文注入。它会将 `manifest.product.brief` 写入 Manifest；其他阶段直接复用。已提交任务恢复使用 `--resume`，不可重复提交。

除无图片的保留原商品模式外，禁止退回宿主 Agent 直接识图。检测多商品时请求用户澄清。

## 3. 构建 Fast Brief

```text
node scripts/build_product_brief.mjs --fast-brief --product-name "<名称或保守品类>" --product-type "<品类>" [--usage "<必要使用方式>"] [--locked-feature "<身份特征>" ...] [--user-selling-point "<用户卖点>" ...] --other-requirements "<要求或无>" --compact
```

输出：

```json
{
  "产品卡": {
    "产品名称": "",
    "产品类型": "",
    "使用方式": "",
    "锁定特征": [],
    "用户卖点锁定": [],
    "其他要求": "无"
  }
}
```

旧任务中的完整产品卡仍可读取；不要为新任务主动生成完整旧Schema。

## 4. 自动继续

产品卡不增加用户确认门。完成后写入manifest并继续Step 2。产品图仍作为Storyboard编辑、Prompt生成和最终选中视频CLI的产品身份参考。
