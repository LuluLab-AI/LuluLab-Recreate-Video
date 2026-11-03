#!/usr/bin/env node
/** Verify a configured LuluLab API key without submitting a paid task. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuluLabClient, resolveApiKey } from './lululab_cli.mjs';

export async function verifyKey({ apiKey, baseUrl, fetchImpl } = {}) {
  const key = apiKey ?? await resolveApiKey();
  const client = new LuluLabClient({ apiKey: key,
    baseUrl: baseUrl ?? process.env.LULULAB_API_BASE_URL ?? 'https://customer.lululab.ai',
    fetchImpl: fetchImpl ?? globalThis.fetch });
  await client.credits();
  return { ok: true, authenticated: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('usage: node scripts/lululab_key_preflight.mjs'); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await verifyKey())); }
    catch (error) { console.error(`LuluLab API Key 预检未通过：${error.message}`); process.exitCode = 1; }
  }
}
