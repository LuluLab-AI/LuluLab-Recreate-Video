# JavaScript migration status — 2026-10-23

The source Skill and the installed Codex Skill use Node.js. All 43 former Python runtime scripts have `.mjs` implementations. The 82 Python source and test files have been removed from the Skill tree; Git history retains the old versions.

The commands in `SKILL.md` and the references invoke Node.js. `scripts/ci_validate.mjs` rejects new `.py` and `.pyi` files. `tests/test_js_migration.mjs` checks the same boundary and the documented entry points.

## Verification

Run `node scripts/ci_validate.mjs` and `node --test tests/*.mjs`. On 2026-10-23, source validation passed and the JavaScript suite reported 91 tests: 89 passed, 2 skipped, 0 failed. The skipped FFmpeg integration tests require the `ass` and `drawtext` filters, which are absent from the local FFmpeg build. Tests include mock service requests, local media operations, and 3×3 and 4×4 storyboard generation.

## Remaining service verification

The conversion is complete at the source level. Real Whisper inference, paid ImageGenV2/VideoGenV2/LibTV calls, and a complete production video recreation have not been run during the migration. The corresponding JavaScript modules have unit or mock coverage, so those live paths need verification before claiming production parity.
