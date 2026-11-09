/** Authoritative prices and available credits for one complete submission. No task POSTs here. */
function credits(value, label) {
  if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value))) throw Error(`Invalid ${label}.`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw Error(`Invalid ${label}.`);
  return amount;
}
export async function assertAvailableCredits(client, required) {
  required = credits(required, 'required credits');
  let available = 0, seen = 0;
  for (let page = 1; ; page++) {
    const result = await client.request(`/credits?page=${page}&pageSize=100`);
    const total = credits(result?.total, 'account count');
    if (!Array.isArray(result?.items)) throw Error('Credit account list is unavailable.');
    for (const account of result.items) {
      const amount = account.creditsAvailable != null ? credits(account.creditsAvailable, 'available credits')
        : Math.max(0, credits(account.creditsBalance, 'credit balance') - credits(account.creditsReserved ?? 0, 'reserved credits'));
      available += amount;
      if (!Number.isSafeInteger(available)) throw Error('Available credit amount exceeds supported limits.');
    }
    seen += result.items.length;
    if (seen >= total) break;
    if (!result.items.length || page >= 10000) throw Error('Credit account pagination is incomplete.');
  }
  if (available < required) {
    const error = new Error(`Insufficient credits. Required: ${required}; available: ${available}. No tasks were submitted.`);
    error.code = 'LULULAB_CREDITS_INSUFFICIENT'; error.status = 402;
    throw error;
  }
  return available;
}
export async function assertPlanBudget(client, items) {
  const estimate = await client.request('/billing/estimates', { method: 'POST', body: { items } });
  await assertAvailableCredits(client, credits(estimate?.credits, 'estimated credits'));
}
export async function quoteTaskBatch(client, forms) {
  if (!Array.isArray(forms) || !forms.length || forms.length > 100) throw Error('A batch requires 1 to 100 tasks.');
  const quoted = [];
  let required = 0;
  for (const form of forms) {
    if (!form || !['VideoGenV2', 'ImageGenV2', 'VideoCreationV1'].includes(form.workflowId) || !form.input || Array.isArray(form.input) || typeof form.input !== 'object')
      throw Error('Invalid task in image/video batch.');
    const quote = await client.request('/billing/quotes', { method: 'POST', body: form });
    if (typeof quote?.id !== 'string' || !quote.id.trim()) throw Error('Credit quote ID is missing.');
    required += credits(quote.credits, 'quoted credits');
    if (!Number.isSafeInteger(required)) throw Error('Batch credit amount exceeds supported limits.');
    quoted.push({ ...form, quoteId: quote.id });
  }
  await assertAvailableCredits(client, required);
  return quoted;
}
export function validateBatchResponse(tasks, count) {
  if (!Array.isArray(tasks) || tasks.length !== count || tasks.some(task => typeof task?.id !== 'string' || !task.id.trim()) || new Set(tasks.map(task => task.id)).size !== count)
    throw Error('Incomplete batch response; inspect owned task history before retrying.');
  return tasks;
}
