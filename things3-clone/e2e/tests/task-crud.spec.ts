import { test, expect, createTask, openTask, openSmartList, closeDetail, toggleTaskCheckbox } from './helpers';

/**
 * Full task lifecycle in the UI:
 *   create → edit title → complete (→ Logbook) → reopen → delete (→ Trash).
 * Every transition is asserted against what's visible in the list.
 */
test.describe('Task CRUD', () => {
  test('create a task in Inbox', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Write the quarterly report');
    await expect(page.getByText('Write the quarterly report', { exact: true }).first()).toBeVisible();
    // Inbox badge reflects the new item.
    await expect(page.getByText('Your Inbox is clear')).toHaveCount(0);
  });

  test('edit a task title', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Draft title');
    await openTask(page, 'Draft title');
    const input = page.getByPlaceholder('New To-Do').first();
    await input.fill('Final title');
    await closeDetail(page);
    await expect(page.getByText('Final title', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Draft title', { exact: true })).toHaveCount(0);
  });

  test('complete a task → moves to Logbook, then reopen', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Task to complete');

    // Complete it via its row checkbox.
    await toggleTaskCheckbox(page, 'Task to complete');

    // It leaves the Inbox (open list).
    await expect(page.getByText('Task to complete', { exact: true })).toHaveCount(0, { timeout: 10_000 });

    // It shows up in the Logbook (completed history).
    await openSmartList(page, 'Logbook');
    await expect(page.getByText('Task to complete', { exact: true }).first()).toBeVisible();

    // Reopen it from the Logbook by toggling its checkbox back.
    await toggleTaskCheckbox(page, 'Task to complete');
    await expect(page.getByText('Task to complete', { exact: true })).toHaveCount(0, { timeout: 10_000 });

    // Back in the Inbox.
    await openSmartList(page, 'Inbox');
    await expect(page.getByText('Task to complete', { exact: true }).first()).toBeVisible();
  });

  test('delete a task → moves to Trash', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Disposable task');

    // Open the detail editor and hit the trash button in its top bar. The two
    // top-bar actions (cancel-circle, then trash) sit at the far top-right of
    // the detail pane; trash is the right-most one. They render as unlabelled
    // Ionicons, so we locate the right-most small pointer element in the top
    // band and click it.
    await openTask(page, 'Disposable task');
    const deleteHandle = await page.evaluateHandle(() => {
      const w = innerWidth;
      const els = [...document.querySelectorAll('*')] as HTMLElement[];
      let best: Element | null = null, bestX = -1;
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.top < 46 && r.width >= 16 && r.width <= 40 && r.height >= 16 && r.height <= 40 && r.right > w - 90 && s.cursor === 'pointer') {
          if (r.left > bestX) { bestX = r.left; best = el; }
        }
      });
      return best;
    });
    const del = deleteHandle.asElement();
    if (!del) throw new Error('delete (trash) button not found in detail top bar');
    await del.click();

    // Editor closes and the task leaves the Inbox.
    await expect(page.getByPlaceholder('New To-Do')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Disposable task', { exact: true })).toHaveCount(0, { timeout: 10_000 });

    // It now lives in the Trash.
    await openSmartList(page, 'Trash');
    await expect(page.getByText('Disposable task', { exact: true }).first()).toBeVisible();
  });
});
