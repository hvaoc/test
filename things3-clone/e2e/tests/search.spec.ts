import { test, expect, createTask, openSmartList } from './helpers';

/**
 * Search: the sidebar "Search" row opens a global search screen with an
 * autofocused input (placeholder "Search all to-dos"). Typing filters the
 * results to fuzzy title matches (src/store/query.js).
 */
test.describe('Search', () => {
  test('typing a query lists only matching tasks', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Alpha widget');
    await createTask(page, 'Beta gadget');

    // Open global search from the sidebar.
    await page.getByText('Search', { exact: true }).first().click();
    const input = page.getByPlaceholder('Search all to-dos');
    await expect(input).toBeVisible();

    await input.fill('Alpha');
    await page.waitForTimeout(300);

    // Only the matching task is listed.
    await expect(page.getByText('Alpha widget', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Beta gadget', { exact: true })).toHaveCount(0);
  });

  test('a non-matching query shows no results', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Alpha widget');

    await page.getByText('Search', { exact: true }).first().click();
    const input = page.getByPlaceholder('Search all to-dos');
    await input.fill('zzzznotathing');
    await page.waitForTimeout(300);

    await expect(page.getByText('Alpha widget', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No to-dos match.')).toBeVisible();
  });
});
