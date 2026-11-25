---
name: canvas-recreation
description: Recreate the structure and pacing of a reference video with your own assets.
metadata:
  upstream: https://github.com/LuluLab-AI/LuluLab-Recreate-Video
  upstream-version: "1.6.0"
  version: "6"
  title-zh: 复刻视频
  title-en: Recreate video
  description-zh: 根据一条参考视频的镜头和节奏，用自有素材复刻成片。
---

# 复刻视频

Use one verified 4–60 second source video from this request or its carried-forward reference. Ask only when the source or a required reference is missing or ambiguous. Optional settings use page defaults. Mention the API key link only if the user asks about API access.

For a finished remake, call `prepare_recreation` with the requested mode, changes and explicit preferences. Default to motion-guided recreation (`deep`). Both modes support AI 新人物 (`ai_generated`, default), 上传指定人物 (`user_provided`) and 沿用原片人物 (`keep_source`). Identify person photos with `personImageIndices` from the verified image list. Remaining supplied images are product references. Keep the original product when no product replacement is requested or when replacement was conditional on an absent image.

Motion-guided defaults to 保留原片声音 (`source`) and also supports AI 生成声音 (`generate`) or 静音 (`mute`). Storyboard supports `generate` (default) and `mute`. Set `useVoiceReference` only when the user requests that an available audio asset guide generated speech. Preserve the requested language and market in the requirement.

Use the prepared plan and estimate on a single canvas approval card. Do not ask customers to confirm the same settings in chat. For a breakdown alone, return the analysis without preparing a paid generation.

## Hosted execution

The website runs the packaged `scripts/run_canvas_recreation.mjs` entry point with one JSON request per stage over standard input. It supplies verified media and measured duration to `prepare`. Quote the returned task and save its exact workflow and input in the approval record. On approval, call `resume` with that checkpoint and use the website's authenticated submission tool. Keep the submission quote and Dispatcher parent ID in the same run so a page refresh or restart resumes the existing task. When the parent reaches a terminal state, call `complete` and render its outcome on the canvas. Selection of the skill starts preparation only. A rejected proposal ends the run before paid submission.

Both modes default to Seedance 2.5 Flash, 480p and 9:16. Apply edits through `revise`, then show the updated quote on the same card before approval. `resume` uses the quoted input as saved, including actions prepared before this update.
