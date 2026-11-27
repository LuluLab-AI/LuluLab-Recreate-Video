---
name: canvas-recreation
description: Recreate the structure and pacing of a reference video with your own assets.
metadata:
  upstream: https://github.com/LuluLab-AI/LuluLab-Recreate-Video
  upstream-version: "1.6.1"
  version: "7"
  title-zh: 复刻视频
  title-en: Recreate video
  description-zh: 根据一条参考视频的镜头和节奏，用自有素材复刻成片。
---

# 复刻视频

Use one verified 4–60 second source video from this request or its carried-forward reference. Follow the upstream skill's short intake and defaults. Mention the API key link only if the user asks about API access.

For a finished remake, offer 分镜复刻 (`storyboard`, follows the source shots and pacing) and 动作模仿 (`deep`, follows actions in the source video) only when the mode is unclear. Once the source, mode and any essential replacement details are available, call `prepare_recreation` with the changes, explicit preferences and resolved defaults. Identify designated person photos with `personImageIndices` from the verified image list. Clarify an ambiguous image role only if needed for a requested change. Keep the original product when no product replacement is requested or when replacement was conditional on an absent image.

Pass the resolved audio mode explicitly. Set `useVoiceReference` only when the user requests that an available audio asset guide generated speech. Record the resolved target market and output language in the requirement.

Follow the upstream confirmation format for the current configuration and available options. Show both with the first editable approval card and with each revised quote. Use the card for the fields and choices it exposes, and briefly list the other supported options alongside it. Offer only modes and settings the canvas can apply. Carry forward any explicit output settings. If the initial card uses different values, apply the requested settings and refresh the quote before asking for approval. For a breakdown alone, return the analysis without preparing a paid generation.

## Hosted execution

The website runs the packaged `scripts/run_canvas_recreation.mjs` entry point with one JSON request per stage over standard input. It supplies verified media and measured duration to `prepare`. Quote the returned task and save its exact workflow and input in the approval record. On approval, call `resume` with that checkpoint and use the website's authenticated submission tool. Keep the submission quote and Dispatcher parent ID in the same run so a page refresh or restart resumes the existing task. When the parent reaches a terminal state, call `complete` and render its outcome on the canvas. Selection of the skill starts preparation only. A rejected proposal ends the run before paid submission.

The card initially proposes Seedance 2.5 Flash, 480p and 9:16 when the user leaves those choices open. Apply edits through `revise`, then show the updated quote on the same card before approval. `resume` uses the quoted input as saved, including actions prepared before this update.
