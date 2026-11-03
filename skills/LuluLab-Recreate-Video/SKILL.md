---
name: LuluLab-Recreate-Video
description: Recreate authorized commerce videos through the same LuluLab Dispatcher parent tasks as the frontend, including storyboard, deep recreation, and element replacement.
license: Apache-2.0
metadata:
  skillhub:
    slug: LuluLab-Recreate-Video
    version: 1.5.0
    displayName: LuluLab-Recreate-Video
    summary: Submit and resume frontend-compatible video recreation tasks.
    tags: [视频复刻, 爆款视频, 电商广告, AI视频]
    homepage: https://github.com/LuluLab-AI/LuluLab-Recreate-Video/tree/main/skills/LuluLab-Recreate-Video
---

# LuluLab-Recreate-Video v1.5.0

## Default execution: Dispatcher parent task

Use `scripts/dispatcher_recreate.mjs` for new full-video tasks. Submit one parent task through Customer API `/billing/quotes` then `/tasks`, exactly as the frontend does. Dispatcher owns analysis, media processing, reference replacement, prompt generation, video generation and assembly. Do not also run the legacy local pipeline or submit its child workflows.

Modes:
- `storyboard` → `StoryboardRecreationV1`, with `storyboardPipelineVersion=2`.
- `deep` → `DeepRecreationV1` (website default), with `deepPipelineVersion=2` and `deepPresentationVersion=1`.
- `element_replace` → `ElementReplacementV1`.

Use the user's selected mode; otherwise use deep recreation, matching the website. Default model is Seedance 2.0 Fast (element replacement uses Seedance 2.5), 720p, 9:16 and audio enabled. For storyboard/deep, collect `creatorMode`: `ai_generated` (website default without person photos), `user_provided` (requires person photos), or `keep_source`. Pass explicit selections rather than inferring preservation from absent photos. AI identity creation belongs to the server parent orchestration, not an extra local task. Product/background references replace those elements; absent references preserve them. Dispatcher/server model behavior and billing rules apply; do not claim legacy local QA or caption postproduction ran.

## Language and user input

Treat interaction language, target market and output language independently. Choose the user's explicit reply language first, then an available host language setting, then the main conversation language. If unclear, retain the previous interaction language; for a new conversation, use the user's message language. Support the user's chosen language, including Chinese, English, Japanese, Korean, Spanish, Portuguese, French, German and Vietnamese; interaction is not limited to Chinese and English. The language of this document or its examples does not set the reply language.

Use the interaction language for every user-facing message: input collection, configuration labels and choices, defaults, estimated credits and billing breakdown, confirmation, progress, errors, recovery and delivery. Translate human-readable server status and billing labels while preserving credit amounts, model/workflow/task IDs, commands, paths and JSON field names. Explain raw CLI output in the interaction language instead of presenting English diagnostics as the final response.

Show output language separately in the configuration. Preserve explicit mode, model, country, language, image and audio choices. Otherwise retain this skill's source-language defaults for the pending confirmation. Never infer the target market or overwrite output language from the conversation language. Speech, captions and copy (where supported by the selected workflow) follow the requested output language, including regional or multilingual requirements. Explain known unsupported settings before submission and let the user choose; do not silently substitute Chinese or English or promise unverified language quality.

Pass `interactionLocale` explicitly in the local configuration. Storyboard mode sends it and `targetCountry`/`targetLanguage` in dedicated fields. Deep/element replacement keep country and output-language requests verbatim in `requirement`, matching the existing frontend contract; do not invent unsupported locale fields in their workflow input. Local explanations still follow the interaction language in every mode.

Translate confirmation examples into the interaction language, including “Estimated consumption: {credits} credits; reply 1 to start or 2 to change.” Accept digits or an explicit equivalent confirmation in any language. A refusal, question or configuration change is not approval. Switching only the reply language keeps the existing generation configuration and approval; changing output language requires an updated request, estimate and confirmation.

Keep generated prompts verbatim for submission. If useful, provide a separately labeled explanation or translation in the interaction language without replacing the original prompt. Preserve the user's original creative requirements. These rules also apply to legacy and prompt-only paths; older references that force Chinese for zh locales and English for all other locales must not override them.

Collect the source video and requested changes; accept optional product, person, background and voice references. Source duration must be measured, 4–60 seconds. Use FFprobe for local video rather than guessing. Require Node.js >=20 and LuluLab credentials (`LULULAB_API_KEY` or existing private `~/.recreate-video-lululab/config.json`). Do not print/store API keys or pass them in command arguments.

Read [the Dispatcher contract and request example](references/DISPATCHER_RECREATION.md) before preparing input. `plan` is offline. The server remains authoritative for model availability, billing, Asset ownership and actual source duration.

## Required configuration confirmation before submission

For every new task, first show a complete configuration table: source video and measured duration, recreation mode, product/person/background/voice reference roles, elements to preserve or replace, target country and video language, model, output duration, count, aspect ratio, resolution, audio settings, and the user's requested changes. Mark user choices, defaults and suggestions; mark server-controlled or unsupported settings accurately rather than promising unavailable options. Outside the table, disclose the selected parent workflow and its billable orchestration; show estimated credits as required below. For legacy or prompt-only requests, disclose the actual billable steps of that path instead.


After the configuration table, display **Estimated consumption: {credits} credits** in the interaction language (translate the label, preserve the amount), then ask for confirmation. Run `estimate --config request.json` on the exact request first. Read `credits`, `breakdown` and `version` from `/billing/estimates`; show the total and available server breakdown for the selected parent orchestration, without adding its child costs again. For multiple parents, estimate each and sum the totals. Never hardcode prices, infer cost from balance changes, or present an estimate as the final charge.

Estimation creates no generation tasks and may run before approval, together with uploads and offline validation. If estimation fails, the total is invalid or the billing scope is incomplete, explain the blocker and stop before submission; unknown cost is not zero. Re-estimate changed configurations. Approval must explicitly cover both the displayed configuration and estimated credits before setting `--generation-approved`. Reuse it for normal stages of the unchanged scope. Submission still uses live server quotes; if pricing changes increase the estimated total, show the updated estimate and obtain renewed confirmation first. Legacy and prompt-only paid paths must estimate their actual scope too; stop if a reliable estimate is unavailable.

Example (replace placeholders with real values, using the user's interaction language): “Estimated consumption: {credits} credits, including {billable steps and quantities}; actual billing follows the server quote at submission. Reply 1 to start with this configuration and estimate, or 2 to change the configuration.”

Ask explicitly whether to start with that displayed configuration and wait for the user's reply before creating any analysis, planning, image or video task. A generic request to recreate a video, invoking this skill, supplying references, silence, or the agent announcing defaults is not configuration approval. Show the final configuration even when the initial request contains parameters. Only explicit confirmation of that displayed configuration permits `submit --generation-approved`; the flag cannot obtain consent itself. Local inspection, preparing files and offline `plan` validation may proceed before confirmation.

Reuse confirmation for the unchanged configuration and its normal parent orchestration, including configured server retries. Changes to configuration, new billing scope or paid client retries require a revised configuration and fresh explicit confirmation. Existing-task polling and downloads need no new confirmation. Apply this rule to legacy and prompt-only submissions as well.

## Execution and recovery

1. Upload local source and reference files with `dispatcher_recreate.mjs upload`; retain the returned Asset ID, URL, MIME type and expiry in request JSON. The source requires the owned temporary file ID, not an asset-library record ID. A public URL alone is insufficient for server-side media processing. If the user supplied only a URL, obtain the source file through the existing authorized download path and upload it, or use its existing owned file object.
2. Build the request, run `plan`, then query `estimate --config ...`. Show mode, source duration, model, output settings, replacements and user requirements. Wait for explicit confirmation of the displayed complete configuration, estimated credits and billing scope as required above; a generic recreation request does not satisfy this checkpoint. The authorization covers this parent task and its normal server-side orchestration, including the server's configured retries; client resubmission is separate.
3. Run `submit --generation-approved` once with a dedicated `--state` file. The script quotes before submission, checkpoints before the task POST, and saves the returned parent task ID immediately.
4. Run `poll --state ...`, reporting actual server stages. If the polling window ends while pending, continue polling the same state; never submit again. Dispatcher continues even when the local client stops. On resume, poll the saved parent ID first; if the saved final file exists, deliver it directly.
5. On success, run `download` and deliver the saved video plus task ID. Download is reusable and never starts generation. For local files, use FFprobe to report actual media information if needed; do not equate successful generation with semantic fidelity.

Failed/cancelled tasks stop with the server error; paid client retries require explicit new authorization and a separate state file. A missing submit response/`submission_unknown` may mean the server created the task: inspect owned task history and reconcile the exact parent ID before recovery. Do not clear state to bypass this guard. A crash may leave `<state>.lock`; verify the previous process stopped before removing only that lock. Never delete the task state to unlock it.

The state stores the exact submitted request, quote ID, parent ID and returned task snapshots. Top-level editorSnapshot uses website field names so task history can restore its settings. After an adapter update, resume existing state with poll/download; do not rebuild an old submission using new defaults or migrate a paid task to the new pipeline. Do not relabel it as a legacy generation manifest. No concurrent process should operate on the same state file.

## Legacy and prompt-only requests

Existing local generation manifests must continue with their saved child task IDs, using [legacy local recovery](references/LEGACY_LOCAL_RECREATION.md); never migrate an in-flight paid task by creating a new parent. Explicit prompt/storyboard-only exports also use that legacy prompt-only path and stop before video submission. The Dispatcher full-video parent task does not expose a prompt-only switch. Load legacy instructions only for those cases or an explicit request for the old local pipeline; they do not override the default path for new full-video tasks.
