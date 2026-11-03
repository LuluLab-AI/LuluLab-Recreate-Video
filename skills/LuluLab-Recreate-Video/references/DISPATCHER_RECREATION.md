# Dispatcher recreation contract

This adapter mirrors `lululab-ui/workshop/src/views/CloneVideoView.vue` and `src/domain/storyboardRecreation.ts` (checked 2026-11-03). Customer authenticates the same owner with a user API key; no Dispatcher internal credential or direct n8n endpoint is needed. Parent task visibility in the frontend requires the same owning account.

## Commands

Run from the skill root:

```sh
node scripts/dispatcher_recreate.mjs upload --file /absolute/source.mp4 --mime-type video/mp4 --output /absolute/source-asset.json
node scripts/dispatcher_recreate.mjs plan --config /absolute/request.json
node scripts/dispatcher_recreate.mjs estimate --config /absolute/request.json
node scripts/dispatcher_recreate.mjs submit --config /absolute/request.json --state /absolute/task-state.json --generation-approved
node scripts/dispatcher_recreate.mjs poll --state /absolute/task-state.json
node scripts/dispatcher_recreate.mjs download --state /absolute/task-state.json --output /absolute/final.mp4
```

`upload` uses `/uploads` followed by multipart POST to the signed ticket, preserving the returned temporary file ID. It does not create a generation task. Use `image/png`, `image/jpeg`, `audio/mpeg`, etc. as appropriate. The signed host never receives the Customer API key. `plan` needs no credentials and does not access the network. `estimate` sends `{items: [buildTask(config)]}` to `/billing/estimates`, returning the server credit total, version and breakdown without creating tasks or touching task state. Display this estimate after the configuration table and obtain explicit approval of both before submission. Estimation failure blocks submission. `submit` calls `/billing/quotes` then creates exactly one `/tasks` parent using its quote ID; quote lookup failure does not create a task. `poll` only calls `GET /tasks/{id}`. `download` only reads the successful parent's `output.video.url`.

## Request JSON

Replace sample file objects with actual uploaded results. `sourceDuration` must come from the actual source. File IDs must belong to the authenticating account.

```json
{
  "mode": "storyboard",
  "source": {
    "id": "11111111-1111-4111-8111-111111111111",
    "url": "https://asset.example/source.mp4",
    "mimeType": "video/mp4"
  },
  "sourceDuration": 12.4,
  "model": "seedance-2-fast",
  "aspectRatio": "9:16",
  "resolution": "720p",
  "generateAudio": true,
  "interactionLocale": "zh-CN",
  "creatorMode": "ai_generated",
  "requirement": "保留原片动作和节奏，换成上传的商品。",
  "productImages": [],
  "personImages": [],
  "backgroundImages": [],
  "referenceAudios": []
}
```

Image/audio arrays contain uploaded file objects with `url`, `mimeType`, optional `expiredAt`/`expiresAt`. Image limits: storyboard 6 with AI person / 7 otherwise; deep 6 with AI or original person / 7 with uploaded person; element replacement 10. At most one voice reference; voice reference requires audio generation. Optional `targetCountry`/`targetLanguage` are supported in storyboard mode; otherwise put the language/country request in `requirement`. For storyboard/deep, creatorMode supports ai_generated, user_provided and keep_source. Without an explicit selection it defaults to user_provided when photos exist, otherwise ai_generated, as on the website. Conflicting photos/modes fail validation. Identity generation is server-side.

The adapter supports the frontend model lists: storyboard uses Seedance 2 Mini/Fast/2/2.5 and Wan 3; deep uses Fast/2/2.5 and Wan 3; element replacement uses 2.5 and Wan 3. Default mode is deep. Default models are storyboard/Fast, deep/Fast and element replacement/2.5, all defaulting to 720p. The recreation page limits Wan to 720p. Source videos are 4–60 seconds; Dispatcher splits them according to model limits. The client passes 15 seconds for Seedance 2/Mini/Fast and 30 seconds for 2.5/Wan, with `adaptive` for 2.5 edit mode, matching the frontend.

The default API base is `https://customer.lululab.ai`; `LULULAB_API_BASE_URL` may override the service root. Server releases must already include the selected parent task worker and workflow registration. This skill change does not deploy backend services or modify n8n workflows.

## Recovery

Use the same state for `poll` and `download`. `Succeeded`, `Failed`, and `Cancelled` are terminal; normal pending states are `Created`, `Pending`, and `Running`. Successful output is `output.video.url`; progress may be in `output.stage` or `attributes.stage`. State snapshots preserve full server output/attributes for inspection.

`submit` with an existing state/ID returns the saved ID without creating another task. A changed request or a legacy manifest is rejected. An uncertain submission without an ID is blocked, including after a crash. Inspect owned task history (`GET /tasks`, filter by workflow ID and creation time), compare the exact input/owner and identify the existing parent before reconciling the state; never guess an ID or blindly retry. Poll errors do not erase state. A local state lock prevents concurrent submissions; after a crash it requires checking that the old process stopped before manual lock removal.

Do not attach in-flight legacy child tasks to a new Dispatcher parent. Complete them with the old manifest path. Server configured child retries remain server behavior; the adapter adds no paid retries or duplicate parent submissions.

## Current website request parity

Storyboard requests explicitly send storyboardPipelineVersion=2, reviewBeforeGeneration=false and postproduction. With no marketingText override, postproduction uses the requirement as marketingText with marketingTextMode=creative_brief; an explicit override uses literal mode. Deep requests explicitly send deepPresentationVersion=1 and creator.mode. Every parent includes a top-level editorSnapshot matching CloneVideoView fields (selected, referenceVideo, sourceVideoDuration, personSource, personPhotos and output settings). Historical state is polled/downloaded as saved; new defaults never rewrite existing task input.
