# Recreate Prompt Module JSON v3

This is a contract adapter for stages 1–10; **it does not independently orchestrate the pipeline**. The host Agent remains responsible for initial user interaction, confirmations, Manifest creation and stages 1–9. In cloud prompt-only mode video generation stays separate. In local Codex full-recreation mode, after the existing one-time start confirmation, execution continues through VideoGenV2 and final delivery by default. The JSON contract below remains the stages 1–10 prompt-module contract, not a contract for video delivery.

## Decision: product analysis can be decoupled

Prefer running product image analysis **once before** a prompt recreation request and pass its `product.brief`, along with the original product image public URLs. In that case, skip ChatGenV2 product analysis inside the recreation task. If `product.brief` is absent and `product.mode=replace`, product analysis still runs via ChatGenV2 inside the Skill as a compatible fallback. Do not regenerate user-provided selling points. Uploaded product images must still be passed as visual reference even with a brief.

CLI `upload` can convert local product/creator images into public URLs **before** assembling the JSON request. Users can continue to upload local files through Skill interaction; the adapter/backend performs the upload. The API request accepts only HTTP(S) `product.images[].url` / `creator.images[].url`. Publicly accessible here means accessible to remote models, not necessarily anonymous or permanent; use suitably scoped, valid URLs and mind expiry.

## Input

```json
{
  "schemaVersion": "lululab.recreate.prompt.v3",
  "input": {
    "benchmarkVideo": {"url": "https://example.com/source.mp4", "mimeType": "video/mp4"},
    "product": {
      "mode": "replace",
      "images": [{"url": "https://example.com/product.png", "mimeType": "image/png"}],
      "brief": {"产品卡": {"产品名称": "卷发棒", "锁定特征": ["黑色手柄"]}},
      "sellingPoints": ["操作简单"], "forbiddenChanges": ["不改变商品外观"],
      "otherRequirements": ""
    },
    "creator": {"mode": "ai_generated", "description": "自然的UGC达人"},
    "settings": {
      "videoModel": "seedance-2-mini", "durationMode": "source",
      "targetCountry": "美国", "targetLanguage": "英语",
      "interactionLocale": "zh-CN", "customRequirement": "保留前三秒Hook"
    }
  }
}
```

- `benchmarkVideo` is required (`url` or local `file` for internal adapter).
- `product.mode`: `keep_source` or `replace`; `replace` requires `images[]` public URLs; `brief` optional Fast Brief, precomputed or caller-provided.
- `creator.mode`: `keep_source`, `ai_generated`, or `user_provided` (requires `images[]` public URLs).
- `settings.durationMode`: `source` or `custom`; `custom` requires positive integer `targetDuration`.
- `storyboardValidationMode` and `maxConcurrency` are intentionally **not** public input fields. Fast validation is fixed, and internal concurrency is limited to five.

## Output

```json
{
  "schemaVersion": "lululab.recreate.prompt.v3",
  "taskId": "task-001", "module": "recreate_prompt_generation",
  "status": "completed", "success": true,
  "progress": {"totalSegments": 1, "completedSegments": 1},
  "output": {
    "segments": [{"segmentId": 1, "status": "completed", "duration": 10,
      "prompt": "Complete video generation prompt...",
      "targetStoryboard": {"url": "https://example.com/target-1.png", "mimeType": "image/png"}}],
    "product": {"mode": "replace", "brief": {"产品卡": {}},
      "referenceImages": [{"url": "https://example.com/product.png", "mimeType": "image/png"}]},
    "creator": {"mode": "ai_generated", "referenceImages": [{"url": "https://example.com/creator.png", "mimeType": "image/png"}]}
  },
  "videoGenerationIncluded": false
}
```

- No `globalStart`, `globalEnd`, `rawStoryboard`, `creatorIds` in public segments.
- Local paths are NEVER returned as output media: `node scripts/recreate_prompt_module.mjs export --manifest TASK/manifest.json --output result.json --upload-missing` uploads missing images via LuluLab CLI and caches the resulting URLs. Without `--upload-missing`, any local media that lacks a previously cached public URL fails closed.
- Internal Manifest retains segment times, raw boards, identity bindings and fast validation metadata for accurate prompting and task recovery.
- `product_image_analysis.mjs` supports either `productImages[]` with remote URLs or existing local paths. When a valid `product.brief` has already been supplied/registered, it skips ChatGenV2.

**Not included:** independent cloud orchestrator, authenticated SaaS API, persistent queue, external object store policy or real paid-model e2e validation.
