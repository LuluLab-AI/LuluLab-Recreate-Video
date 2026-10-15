# Dual-language policy for video prompts

Resolve once from saved interaction locale, not target country or targetLanguage:
- `zh`, `zh-CN`, `zh-TW` etc. => ALL instruction/narration text in **Chinese**.
- Any other interaction locale, including `th`, `fr`, `pt-BR`, `en` => ALL instruction/narration text in **English**.

The instruction channel includes reference roles, camera, scene, timing, constraints, KEEP/CHANGE/AUTO-DESIGN explanations, transitions, audio directions, segment labels and ending state. Never write those explanations in Thai just because the ad is Thai.

The content channel includes spoken dialogue, TTS scripts, exact quotations, and permitted on-screen text/subtitles; keep it in the requested target-video language unchanged. IDs, proper nouns and brand packaging text remain literal. Never translate a spoken quote to the instruction language. Do not invent subtitles that are forbidden by the existing skill.

Example with interaction `zh-CN` and target `th-TH`:
`0.30–4.10 秒：达人展示一瓶和两袋补充装，口型精确同步泰语口播："เราจะได้ไปทั้งหมดนี้ในมือจุ๊บเลยนะคะ 1 แกลลอนแล้วก็ 2 ถุงรีฟิล"。`

Example with interaction `fr-FR` and target `th-TH`:
`0.30–4.10s: Creator presents one bottle and two refill pouches. Lip-sync precisely to Thai dialogue: "เราจะได้ไปทั้งหมดนี้ในมือจุ๊บเลยนะคะ 1 แกลลอนแล้วก็ 2 ถุงรีฟิล".`

Before registering prompts, review all descriptive language (excluding quotations/brand names/IDs) and correct any foreign-language instruction text. When resuming older prompts created under the old target-language-instructions rule, regenerate prompt bodies under this policy; do not simply translate complete text wholesale or edit already generated video files.
