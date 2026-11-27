# Dispatcher recreation contract

This adapter mirrors `lululab-ui/workshop/src/views/CloneVideoView.vue` and `src/domain/storyboardRecreation.ts`. Customer authenticates the same owner with a user API key; no Dispatcher internal credential or direct n8n endpoint is needed. Parent task visibility in the frontend requires the same owning account.

## Commands

Run from the skill root:

```sh
node scripts/dispatcher_recreate.mjs upload --file /absolute/source.mp4 --mime-type video/mp4 --output /absolute/source-asset.json
node scripts/dispatcher_recreate.mjs plan --config /absolute/request.json
node scripts/dispatcher_recreate.mjs estimate --config /absolute/request.json
node scripts/dispatcher_recreate.mjs submit --config /absolute/request.json --state /absolute/task-state.json --generation-approved --max-credits <approved-total>
node scripts/dispatcher_recreate.mjs poll --state /absolute/task-state.json
node scripts/dispatcher_recreate.mjs download --state /absolute/task-state.json --output /absolute/final.mp4
```

`upload` uses `/uploads` followed by multipart POST to the signed ticket, preserving the returned temporary file ID. It does not create a generation task. Use `image/png`, `image/jpeg`, `audio/mpeg`, etc. as appropriate. The signed host never receives the Customer API key. `plan` needs no credentials and does not access the network. `estimate` sends `{items: [buildTask(config)]}` to `/billing/estimates`, returning the server credit total, version and breakdown without creating tasks or touching task state. Present the settings and estimate together if a confirmation is needed. Estimation failure blocks submission. `submit` calls `/billing/quotes` then creates exactly one `/tasks` parent using its quote ID; a failed quote or a quote above the approved cap stops before task submission. `poll` only calls `GET /tasks/{id}`. `download` only reads the successful parent's `output.video.url`.

## Request JSON

The sample illustrates a user-selected motion-guided request. Every new request must include the user-selected `mode` (`storyboard`, `deep`, or `element_replace`). Apply explicit choices and the defaults in [SKILL.md](../SKILL.md) before estimating. Replace sample file objects with actual uploaded results. `sourceDuration` must come from the actual source. File IDs must belong to the authenticating account.

```json
{
  "mode": "deep",
  "source": {
    "id": "11111111-1111-4111-8111-111111111111",
    "url": "https://asset.example/source.mp4",
    "mimeType": "video/mp4"
  },
  "sourceDuration": 12.4,
  "model": "seedance-2-5-flash",
  "aspectRatio": "9:16",
  "resolution": "480p",
  "outputAudioMode": "source",
  "interactionLocale": "zh-CN",
  "creatorMode": "ai_generated",
  "requirement": "保留原片动作和节奏，换成上传的商品。",
  "productImages": [],
  "personImages": [],
  "backgroundImages": [],
  "referenceAudios": []
}
```

Image and audio arrays contain uploaded file objects with `url`, `mimeType`, and optional expiration. The website accepts up to 10 reference images, subject to model limits. Grok storyboard accepts up to 6 and does not support voice references. Both modes accept `ai_generated`, `user_provided` with designated person photos, or `keep_source`. Dedicated person photos select `user_provided` if the mode was omitted.

For new requests use `outputAudioMode`. Motion-guided defaults to `source` and writes this field to the workflow input. Storyboard defaults to `generate` and writes `settings.generateAudio`. Both record the chosen mode and mute state in the editor snapshot. Only `generate` forwards the optional single voice reference. A retained draft voice reference is omitted from the workflow input when muted or preserving the original track. Explicit legacy `generateAudio` values still map to `generate` or `mute` when no mode is supplied. An intentionally supplied voice reference with neither setting selects `generate`.

For deep and element replacement, keep market and language requirements in `requirement`. Storyboard also accepts `targetCountry` and `targetLanguage`.

Element replacement supports Seedance 2.5 Flash (`seedance-2-5-flash`), Seedance 2.5 (`seedance-2-5`), and Wan 3 (`wan-3`). Seedance 2.5 Flash supports 480p and 720p. Wan 3 uses 720p in this adapter. Source videos can be 4–60 seconds. The per-segment model limit is 15 seconds for the Seedance 2.0 models and 30 seconds for Seedance 2.5 Flash, Seedance 2.5 and Wan 3, with a 15-second per-segment limit for Wan 3 element replacement. For motion-guided recreation and element replacement with either Seedance 2.5 model, the adapter sends `adaptive` and keeps the selected ratio separately for motion-guided recreation.

The default API base is `https://customer.lululab.ai`; `LULULAB_API_BASE_URL` may override the service root. Server releases must already include the selected parent task worker and workflow registration. This skill change does not deploy backend services or modify n8n workflows.

## Recovery

Use the same state for `poll` and `download`. `Succeeded`, `Failed`, and `Cancelled` are terminal; normal pending states are `Created`, `Pending`, and `Running`. Successful output is `output.video.url`; progress may be in `output.stage` or `attributes.stage`. State snapshots preserve full server output/attributes for inspection.

`submit` with an existing state/ID returns the saved ID without creating another task. A changed request or a legacy manifest is rejected. An uncertain submission without an ID is blocked, including after a crash. Inspect owned task history (`GET /tasks`, filter by workflow ID and creation time), compare the exact input/owner and identify the existing parent before reconciling the state; never guess an ID or blindly retry. Poll errors do not erase state. A local state lock prevents concurrent submissions; after a crash it requires checking that the old process stopped before manual lock removal.

Do not attach in-flight legacy child tasks to a new Dispatcher parent. Complete them with the old manifest path. Server configured child retries remain server behavior; the adapter adds no paid retries or duplicate parent submissions.

## Current website request parity

Storyboard requests round target duration up and send storyboardPipelineVersion=2, reviewBeforeGeneration=false and postproduction. With no marketingText override, postproduction uses the requirement as marketingText with marketingTextMode=creative_brief; an explicit override uses literal mode. Motion-guided requests explicitly send deepPresentationVersion=1, creator.mode and outputAudioMode. Every parent includes a top-level editorSnapshot matching CloneVideoView fields (selected, referenceVideo, sourceVideoDuration, personSource, personPhotos and output settings). Historical state is polled/downloaded as saved; new defaults never rewrite existing task input.
