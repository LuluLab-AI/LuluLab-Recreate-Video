# LuluLab-Recreate-Video

## Overview

This Skill recreates an **authorized** commerce video using a source video, product and creator references, a reviewed segment plan, storyboards and LuluLab generation. It is for creators and merchants with permission to use the source material. The Agent Skills root is this repository's `skills/LuluLab-Recreate-Video/` folder, containing `SKILL.md`.

## Key Features

- Preprocesses and analyzes the source video through `RecreateVideoPromptV3`.
- Builds segment storyboards, binds product and creator references, and presents prompts for confirmation.
- Uses `ImageGenV2` for image work and `VideoGenV2` with Seedance2 Mini for video generation. It saves task IDs to recover work without blind paid retries.
- New tasks default to one realistic 2×2 creator identity sheet per selected main creator, generated through the bundled LuluLab CLI with GPT Image 2.5 Sunburst. Choose the source creator or supply creator photos instead. The same sheet guides storyboard edits and every relevant video segment.
- Registers all user supplied product and creator photos independently of replacement choices and audits the final video references before submission.
- Keeps interaction language separate from the target video's language under the existing Skill rules.

## Requirements

A file-capable Agent Skills host such as Codex or Claude Code, or WorkBuddy with file-based Skills and command execution, Python 3.9+, FFmpeg/FFprobe, Node.js 20+, macOS, Windows or Linux, network access to LuluLab, and a LuluLab API Key for the first service call are required. Run `python3 scripts/host_preflight.py` to identify missing capabilities. The Node.js CLI is bundled at `scripts/lululab_cli.mjs`; there is no npm or `npx` install step.

## Installation

Ask your agent:

> Please install this LuluLab Skill into my current AI agent environment: https://github.com/LuluLab-AI/LuluLab-Recreate-Video . Follow the project's official installation instructions.

The Agent should review the repository, then copy the **whole** `LuluLab-Recreate-Video/` folder into its current user Skill directory under the name `LuluLab-Recreate-Video`. Agent locations vary, so confirm the current location in that agent's documentation. Keep `SKILL.md`, `scripts/`, `references/`, `core/`, `utils/` and `assets/` together. Do not copy only `SKILL.md` or the repository's `skills/` wrapper. If the same Skill is already installed, compare versions and ask before replacement; leave other Skills alone. Run `python3 scripts/host_preflight.py`, `node scripts/lululab_cli.mjs --help` and `python3 scripts/video_cli_preflight.py --help` from the Skill root, reload the agent's Skill list, and verify discovery.

## Quick Start

- “Use $LuluLab-Recreate-Video to recreate this authorized 20-second product video with my new product photos. Show the plan before paid generation.”
- “Recreate this authorized commerce video for an English-speaking US audience, but reply to me in Chinese.”

The first confirmation covers source upload and the initial paid image/video generation; subsequent paid retries require a new decision. See [SKILL.md](SKILL.md).

## Configuration

The bundled CLI supports `upload <file>`, `user --credits`, `task submit --workflow-id <id> --input <JSON>` and `task fetch --id <id>`. Set `LULULAB_API_KEY` locally or use the existing private `~/.recreate-video-lululab/config.json` with an `apiKey` field. Do not put a Key in GitHub, a manifest, prompt or command argument. `LULULAB_NODE` may point to Node.js when it is absent from `PATH`; `LULULAB_CLI` may point only to another reviewed `.mjs` entry. See [the CLI contract](references/lululab_cli_contract.md).

## Supported Languages

English and Chinese interaction follow the Skill's existing language priority rules. A requested target video language is independent from the conversation language.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Skill is not recognized | Confirm the `LuluLab-Recreate-Video` root and its `SKILL.md`; reload discovery. |
| CLI is missing | Check Node.js 20+, `scripts/lululab_cli.mjs`, and `--help`. |
| API Key is missing | Configure `LULULAB_API_KEY` locally before the first service call. |
| Network request fails | Check service access and resume the saved task ID before any resubmission. |
| Model call fails | Inspect the terminal task status; do not switch models or repeat a paid task silently. |
| Dependency is missing | Install the reported Python, FFmpeg or FFprobe dependency and rerun preflight. |

## Support

Website: https://lululab.ai  
Email: contact@lululab.ai
