import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateInput,SCHEMA} from '../scripts/recreate_prompt_module.mjs';
import {resolvePromptLanguage,resolveInteractionLocale} from '../scripts/interaction_language.mjs';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
test('validate source input',()=>{assert.equal(validateInput({schemaVersion:SCHEMA,input:{benchmarkVideo:{url:'https://example.com/v.mp4'}}}).schemaVersion,SCHEMA)});
test('reject invalid duration',()=>{assert.throws(()=>validateInput({schemaVersion:SCHEMA,input:{benchmarkVideo:{url:'https://example.com/v.mp4'},settings:{durationMode:'custom',targetDuration:0}}}))});
test('reject non-uploaded product',()=>{assert.throws(()=>validateInput({schemaVersion:SCHEMA,input:{benchmarkVideo:{url:'https://example.com/v.mp4'},product:{mode:'replace',images:[{file:'/tmp/x.png'}]}}}))});
test('language precedence and prompt language',()=>{assert.equal(resolveInteractionLocale(null,{configuredLocale:'fr-FR',previousLocale:'zh-CN'}),'fr-fr');assert.equal(resolvePromptLanguage('zh-CN'),'zh');assert.equal(resolvePromptLanguage('th-TH'),'en')});
test('Skill runtime and tests contain no Python source or Python command', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else assert.equal(entry.name.endsWith('.py') || entry.name.endsWith('.pyi'), false, path);
    }
  }
  await walk(root);
  const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /Local Codex\/Agent full-recreation mode \(default\)/);
  assert.match(skill, /Cloud prompt-only mode/);
  assert.match(skill, /VideoGenV2/);
  assert.match(skill, /node scripts\/run_generation\.mjs/);
  assert.doesNotMatch(skill, /python(?:3)?\s+scripts\//i);
});
