# Prompt display and export

The data source is the registered segments in analysis/local-video-prompts.json. Never reconstruct stored prompts from chat text. Use SKILL.md's stable interaction language for every heading, title, metadata value, link label, status, and explanation; translate display titles without modifying stored data.

## Export first

After registering prompts, export each exact prompt with:

```text
python3 scripts/export_prompt_texts.py --manifest <manifest> --output-dir <task>/prompts
```

Use the returned absolute paths for backup links. Keep all prompts complete and unchanged in the files, including target-language dialogue and identifiers. Exports do not add an approval gate.

## Choose the display path

Prompt instructions must be Chinese for `zh` interaction locales and English for all other locales; target-language dialogue and permitted subtitles stay verbatim in the same prompt. Mixed-language dialogue does NOT make the prompt a foreign-language prompt. Display every registered segment's COMPLETE unchanged prompt by default, each in its own code block. Provide text-file backups as well. Never hide or replace full prompts with summaries just because the speech is in Thai/Portuguese/etc. Surrounding UI labels follow interaction locale (may differ from English prompt instructions). Do not modify stored prompts during display.

## Full inline example

Translate this example's headings, labels, segment titles, and status text to the interaction language. Missing metadata is displayed as the localized equivalent of "Not provided"; do not guess values.

````markdown
Video recreation prompts

Generated <count> segment prompts. The code blocks can be copied directly; text files are backups.

| Segment | Title | Duration | Source time window |
|---|---|---:|---:|
| 01 | <localized title> | <duration>s | <globalStart>–<globalEnd>s |

Segment 01 | <localized title>

<duration>s · Source <globalStart>–<globalEnd>s · Storyboard <storyboardIds>

```text
<exact registered prompt body>
```

[Open Segment 01 text backup](</absolute/path/segment-01-prompt.txt>)
````

After displaying all segments through the applicable path, state the actual next status once and continue authorized generation. Do not ask for a new confirmation. If the required video CLI is unavailable, explain the blocker in the interaction language, preserve all artifacts, and list the required reference images and prompt backups. Do not switch providers automatically.
