---
name: LuluLab-Recreate-Video
slug: lululab-recreate-video
version: 1.6.1
displayName: LuluLab 视频复刻
summary: Recreate commerce videos through LuluLab Dispatcher tasks.
homepage: https://github.com/LuluLab-AI/LuluLab-Recreate-Video
description: Recreate authorized commerce videos through the same LuluLab Dispatcher parent tasks as the frontend, including storyboard, deep recreation, and element replacement.
license: Apache-2.0
metadata:
  skillhub:
    slug: lululab-recreate-video
    version: 1.6.1
    displayName: LuluLab 视频复刻
    summary: Submit and resume frontend-compatible video recreation tasks.
    tags: [视频复刻, 爆款视频, 电商广告, AI视频]
    homepage: https://github.com/LuluLab-AI/LuluLab-Recreate-Video
---

# LuluLab-Recreate-Video v1.6.1

## LuluLab canvas host

When the host provides `prepare_recreation`, use the [canvas host contract](hosts/lululab/canvas-recreation/SKILL.md) with verified attachments and the creative brief. The website provides account authorization, the approval card, durable task state and delivery back to the canvas. Use the website's approval interaction and task status. The standalone commands below apply to externally installed agents.

Use the canvas approval card for paid generation approval. Present the current configuration, available options and credit estimate as described below.

## Default execution: Dispatcher parent task

Use `scripts/dispatcher_recreate.mjs` for new full-video tasks. Submit one parent task through Customer API `/billing/quotes` then `/tasks`, exactly as the frontend does. Dispatcher owns analysis, media processing, reference replacement, prompt generation, video generation and assembly. Do not also run the legacy local pipeline or submit its child workflows.

Modes:
- `storyboard` → `StoryboardRecreationV1`, with `storyboardPipelineVersion=2`.
- `deep` → `DeepRecreationV1`, with `deepPipelineVersion=2` and `deepPresentationVersion=1`.
- `element_replace` → `ElementReplacementV1`. Model choices are Seedance 2.5 Flash (`seedance-2-5-flash`), Seedance 2.5, and Wan 3.

Use the mode the user explicitly chooses. The parent task follows the source duration. Keep the explicit source video and any selected references.

| Mode | Person | Audio |
| --- | --- | --- |
| 分镜复刻 / Storyboard | AI 新人物 (default), 上传指定人物, 沿用原片人物 | AI 生成声音 (default) or 静音. One optional voice reference for generated audio |
| 动作模仿 / Motion-guided | AI 新人物 (default), 上传指定人物, 沿用原片人物 | 保留原片声音 (default when an audio track exists), AI 生成声音, or 静音. One optional voice reference for generated audio |

Set `creatorMode` to `ai_generated`, `user_provided` or `keep_source`. Dedicated person photos supplied for a person replacement select `user_provided`. A generic image attachment does not by itself identify a person reference. Preserve the original product and background unless a replacement is requested. Set `outputAudioMode` explicitly to `source`, `generate` or `mute` for new configurations. In motion-guided mode, `source` extracts and restores the original track. Voice references apply to `generate` only.

## Language and user input

Treat interaction language, target market and output language independently. Choose the user's explicit reply language first, then an available host language setting, then the main conversation language. If unclear, retain the previous interaction language; for a new conversation, use the user's message language. Support the user's chosen language, including Chinese, English, Japanese, Korean, Spanish, Portuguese, French, German and Vietnamese; interaction is not limited to Chinese and English. The language of this document or its examples does not set the reply language.

Use the interaction language for every user-facing message: input collection, configuration labels and choices, defaults, estimated credits and billing breakdown, confirmation, progress, errors, recovery and delivery. Translate human-readable server status and billing labels while preserving credit amounts, model/workflow/task IDs, commands, paths and JSON field names. Explain raw CLI output in the interaction language instead of presenting English diagnostics as the final response.

Show output language separately from target market in the configuration. Each follows the source when unspecified. Never infer either from the conversation language. Speech, captions and copy (where supported by the selected workflow) follow the requested output language, including regional or multilingual requirements. If the source has no audio track, use mute for an unspecified motion-guided audio setting and disclose it with the estimate. If the user explicitly requested original audio, explain that the source has no track and ask whether to generate audio or mute before quoting. Do not silently substitute Chinese or English or promise unverified language quality.

Pass `interactionLocale` explicitly in the local configuration. Storyboard mode sends it and `targetCountry`/`targetLanguage` in dedicated fields. Deep/element replacement keep country and output-language requests verbatim in `requirement`, matching the existing frontend contract; do not invent unsupported locale fields in their workflow input. Local explanations still follow the interaction language in every mode.

Translate confirmation examples into the interaction language, including “Estimated consumption: {credits} credits; reply 1 to start or 2 to change.” Accept digits or an explicit equivalent confirmation in any language. A refusal, question or configuration change is not approval. Switching only the reply language keeps the existing generation configuration and approval; changing output language requires an updated request, estimate and confirmation.

Keep generated prompts verbatim for submission. If useful, provide a separately labeled explanation or translation in the interaction language without replacing the original prompt. Preserve the user's original creative requirements. These rules also apply to legacy and prompt-only paths; older references that force Chinese for zh locales and English for all other locales must not override them.

Collect the source video and requested changes; accept optional product, person, background and voice references. Source duration must be measured, 4–60 seconds. Use FFprobe for local video rather than guessing. Require Node.js >=20 and LuluLab credentials (`LULULAB_API_KEY` or existing private `~/.recreate-video-lululab/config.json`). If a standalone API step needs a key and the key is missing or invalid, tell the user in the conversation language to sign in at [LuluLab API Keys](https://www.lululab.ai/workshop/keys), get an API key, and configure `LULULAB_API_KEY` securely on their device. Share the same link if the user asks where to get a key. Never ask them to paste a key in chat. Skip unsolicited reminders when a valid key is already configured. Do not print/store API keys or pass them in command arguments.

All three recreation modes use the website's video reference image rule for every video model: product, person and background images must be real JPEG/JPG (`image/jpeg`), PNG (`image/png`) or WebP (`image/webp`) files. Reject JFIF, GIF, BMP and unsupported MIME types before upload; `plan` also rejects unsupported uploaded image objects before estimation or submission. Tell the user which image failed and ask for conversion and re-upload. Do not relabel a file or its MIME type to bypass the check. This restriction does not apply to the source video or voice references.

Read [the Dispatcher contract and request example](references/DISPATCHER_RECREATION.md) before preparing input. `plan` is offline. The server remains authoritative for model availability, billing, Asset ownership and actual source duration.

## Collect essentials, then confirm with the estimate

Keep the first reply short. Request a source only if missing, offer mode choices only if unclear, and invite the user to mention any intended changes or attach relevant references. A specific editing request can establish the mode. Ask a targeted follow-up only when an essential input is missing, an asset's role is needed to perform a requested change, or an explicit choice cannot be applied. A request with no changes specified can use the defaults, except element replacement needs a replacement target.

For a bare “复刻视频” with no attachment, use wording like “请发参考视频（文件或链接），并选分镜复刻（跟镜头和节奏）、动作模仿（跟人物动作）或元素替换（换指定内容）。有想改的地方一起告诉我。” List only modes supported by the host.

Carry forward explicit choices and fill the remaining settings before estimating. Use the person and audio defaults above, with generated audio if the user asks to use a voice reference. Default to Seedance 2.5 Flash, 480p and 9:16 for storyboard and motion-guided recreation. For element replacement, use Seedance 2.5, 720p, 9:16 and generated audio by default. For an explicit model choice, use output defaults it supports and clarify any incompatible explicit setting. Proceed to estimate once the source, mode and any essential replacement details are available.

Once the source, mode and required references are resolved, show the current configuration and available options together in the first approval and again after any change. In standalone chat, use one three-column Markdown table. Use these exact column headings in Chinese and translate them and the option names into the interaction language when replying in another language.

| 项目 | 当前配置项 | 可选配置项 |
|---|---|---|
| … | … | … |

Use a separate row for the source video, measured duration, recreation mode, model, resolution, aspect ratio, product, person, background, audio, target market, output language, and other requirements. Show the chosen value and any reference file and its role in the middle column. In the right column, list concrete choices for that row or describe its constraint, such as duration following the source. Include every supported mode and model for the current configuration, the resolutions and aspect ratios for the current model, any required reference files or setting changes, and how to edit free-text fields. Base the choices on the current host and applicable workflow and model constraints. For standalone model and output settings, use `scripts/recreation_task.mjs` and the Dispatcher contract, with the server authoritative for availability. Filter choices by the supplied references and source capabilities, or state what needs to change to make a choice available.

In standalone chat, put the live credit estimate and short billing breakdown for the current configuration below the table. End with “Reply 1 to start with the current settings or 2 to change them. You can also name the setting and value directly.” When the user changes a setting, preserve their other choices where compatible, resolve any dependencies, and obtain a fresh estimate and confirmation for the revised configuration. An explicit instruction to start within a stated credit limit already covers an unchanged request within that limit. On canvas, use the approval card for confirmation.

Run `estimate --config request.json` before a paid submit. Use the approved limit or quoted amount as `--max-credits` with `--generation-approved`. If the live quote exceeds that amount or the billable scope changes, obtain approval only for the new scope or price. Polling, downloads and normal server-managed stages reuse the original task and approval.

## Complete credit admission

One full-video parent reserves its complete quoted scope before its segments run. For legacy or explicitly selected local generation, wait until every unsubmitted segment in the approved scope has its final prompt and references, then use one `/tasks/batch` request. Quote and sum all segments, check available credits after holds, and let the server freeze the entire batch atomically. Never submit ready segments individually or silently reduce the scope when credits are insufficient. Preserve saved task IDs and batch quote IDs when recovering. See `scripts/credit_batch.mjs` and the legacy generation rules for the executable path.

## Execution and recovery

1. Resolve the configuration as above. Then upload local source and reference files with `dispatcher_recreate.mjs upload`; retain the returned Asset ID, URL, MIME type and expiry in request JSON. The source requires the owned temporary file ID, not an asset-library record ID. A public URL alone is insufficient for server-side media processing. If the user supplied only a URL, obtain the source file through the existing authorized download path and upload it, or use its existing owned file object.
2. Build the request, run `plan`, then query `estimate --config ...`. Use the combined approval flow above.
3. Run `submit --generation-approved --max-credits <approved-total>` once with a dedicated `--state` file. The script quotes before submission, checkpoints before the task POST, and saves the returned parent task ID immediately.
4. Run `poll --state ...`, reporting actual server stages. If the polling window ends while pending, continue polling the same state; never submit again. Dispatcher continues even when the local client stops. On resume, poll the saved parent ID first; if the saved final file exists, deliver it directly.
5. On success, run `download` and deliver the saved video plus task ID. Download is reusable and never starts generation. For local files, use FFprobe to report actual media information if needed; do not equate successful generation with semantic fidelity.

Failed/cancelled tasks stop with the server error; paid client retries require explicit new authorization and a separate state file. A missing submit response/`submission_unknown` may mean the server created the task: inspect owned task history and reconcile the exact parent ID before recovery. Do not clear state to bypass this guard. A crash may leave `<state>.lock`; verify the previous process stopped before removing only that lock. Never delete the task state to unlock it.

The state stores the exact submitted request, quote ID, parent ID and returned task snapshots. Top-level editorSnapshot uses website field names so task history can restore its settings. After an adapter update, resume existing state with poll/download; do not rebuild an old submission using new defaults or migrate a paid task to the new pipeline. Do not relabel it as a legacy generation manifest. No concurrent process should operate on the same state file.

## Legacy and prompt-only requests

Existing local generation manifests must continue with their saved child task IDs, using [legacy local recovery](references/LEGACY_LOCAL_RECREATION.md); never migrate an in-flight paid task by creating a new parent. Explicit prompt/storyboard-only exports also use that legacy prompt-only path and stop before video submission. The Dispatcher full-video parent task does not expose a prompt-only switch. Load legacy instructions only for those cases or an explicit request for the old local pipeline; they do not override the default path for new full-video tasks.
