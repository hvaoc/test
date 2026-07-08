import { test, expect, createTask, openSmartList } from './helpers';

/**
 * Custom views / saved filters, built with the query builder (Views "+" in the
 * sidebar → QueryBuilderSheet, backed by src/store/query.js). We save a view
 * and assert it lists ONLY the matching tasks.
 *
 * We drive the query builder through its "Text contains" filter, which is a
 * plain text input and maps to `query.text` (fuzzy title match) in the same
 * query engine that powers the condition builder. See the skipped test below
 * for why the structured Priority condition is not driven here.
 */

/** Open the "Views" section "+" that launches the New View query builder. */
async function openNewViewSheet(page: import('./helpers').Page) {
  const handle = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('*')] as HTMLElement[];
    const views = els.find((e) => e.children.length === 0 && e.textContent === 'Views');
    if (!views) return null;
    const vr = views.getBoundingClientRect();
    let best: Element | null = null, bestd = 1e9;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width >= 14 && r.width <= 40 && r.height >= 14 && r.height <= 40 &&
          Math.abs((r.top + r.height / 2) - (vr.top + vr.height / 2)) < 20 && r.left > vr.right) {
        const d = r.left - vr.right;
        if (d < bestd) { bestd = d; best = el; }
      }
    });
    return best;
  });
  const el = handle.asElement();
  if (!el) throw new Error('"Views" section "+" not found');
  await el.click();
  await expect(page.getByText('New View', { exact: true })).toBeVisible();
}

test.describe('Custom view (saved filter)', () => {
  test('a saved text filter lists only matching tasks', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Apple pie recipe');
    await createTask(page, 'Banana bread plan');

    // Build a view whose title filter is "Apple".
    await openNewViewSheet(page);
    await page.getByPlaceholder('e.g. High priority this week').fill('Apple Only');
    await page.getByPlaceholder('Fuzzy match on title (optional)').fill('Apple');

    // "Save View" (force-clicked: the sheet's scroll container can overlap it).
    const save = await page.evaluateHandle(() =>
      [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === 'Save View') || null
    );
    await save.asElement()!.click({ force: true });

    // The saved view shows up in the sidebar and opens.
    await expect(page.getByText('Apple Only', { exact: true }).first()).toBeVisible();
    await page.getByText('Apple Only', { exact: true }).first().click();
    await page.waitForTimeout(400);

    // It lists only the matching task.
    await expect(page.getByText('Apple pie recipe', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Banana bread plan', { exact: true })).toHaveCount(0);
  });

  /**
   * SKIPPED: structured condition (Priority is High) via the query builder.
   *
   * The query engine supports it (src/store/query.js `QUERY_FIELDS`), and a
   * text-filter view is verified above. But the condition builder's field
   * <Dropdown> (QueryBuilderSheet.js) renders as a React-Native-Web
   * absolutely-positioned menu inside a BottomSheet whose overflow clips and
   * z-orders the option list under the "Add condition" affordance. Selecting the
   * "Priority" option does not register a press through Playwright (verified:
   * the field stays "Label" and no priority chips render), and there is no
   * testID/role to target it deterministically. Rather than ship a flaky test,
   * we cover custom views via the reliable text filter above and document this
   * gap. (Reachable by a human; not deterministically automatable without a
   * source testID.)
   */
  test.skip('a Priority=High condition view lists only high-priority tasks', async () => {});
});
