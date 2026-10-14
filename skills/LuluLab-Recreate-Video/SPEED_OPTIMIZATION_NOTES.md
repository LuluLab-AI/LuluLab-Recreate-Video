# Speed optimization (2026-10-14)

- Default video generation concurrency increases from 3 to 5 (configurable 1–8).
- Upload reference files from all new segments in one batch; content-addressed deduplication by SHA256.
- Reference uploads use bounded parallelism (maximum 8; default 5 from generation runner).
- Preserve per-segment reference order, existing URL expiry/HEAD validation, and atomic shared cache write.
- Preserve LuluLab Node CLI, API key, workflows, image/video model selection, and task recovery logic.
- This change does not claim to parallelize AI creator generation with storyboard editing or alter preprocessing.
