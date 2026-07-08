import {
  test,
  expect,
  createProject,
  toggleProjectTaskCheckbox,
  setDisplayCompletedToggle,
} from './helpers';

/**
 * Settings: the "Show completed" preference.
 *
 * NOTE on where this lives: the full SettingsSheet (with its own "Show
 * completed") is only reachable from the signed-in account popover, so it's not
 * available in the offline path we test against. The SAME preference
 * (`settings.showCompleted`) is exposed by the project "Display" popover as the
 * "Completed tasks" switch — reachable offline — so we drive it there.
 *
 * `showCompleted` defaults to TRUE (completed tasks show inside projects), so
 * the cycle is: complete a task (visible) → toggle OFF (hidden) → toggle ON
 * (visible again).
 */
/** Open the project "Display" popover and wait for the "Completed tasks" row. */
async function openDisplay(page: import('./helpers').Page) {
  await page.getByText('Display', { exact: true }).first().click();
  await expect(page.getByText('Completed tasks')).toBeVisible();
}

/** Close the Display popover and wait for it to dismiss. */
async function closeDisplay(page: import('./helpers').Page) {
  // The popover is a full-screen backdrop Pressable; clicking a corner well away
  // from the card dismisses it. Retry via Escape if it lingers.
  await page.mouse.click(40, 40);
  await expect(page.getByText('Completed tasks')).toHaveCount(0, { timeout: 5_000 }).catch(async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByText('Completed tasks')).toHaveCount(0, { timeout: 5_000 });
  });
}

test.describe('Settings — show completed', () => {
  test('toggling "Completed tasks" shows/hides completed tasks', async ({ page }) => {
    await createProject(page, 'Sprint');
    await page.getByText('Sprint', { exact: true }).first().click();
    await page.waitForTimeout(400);

    // Add a task to the project and complete it.
    await page.getByText('Add task', { exact: true }).first().click();
    await page.getByPlaceholder('Task name').fill('Finished chore');
    await page.getByText('Add task', { exact: true }).last().click();
    await expect(page.getByText('Finished chore', { exact: true }).first()).toBeVisible();

    // Complete it, and confirm it's actually completed (title struck through).
    await toggleProjectTaskCheckbox(page, 'Finished chore');
    await expect(async () => {
      const decoration = await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].find(
          (e) => e.children.length === 0 && e.textContent === 'Finished chore'
        ) as HTMLElement | undefined;
        return el ? getComputedStyle(el).textDecorationLine : 'missing';
      });
      expect(decoration).toContain('line-through');
    }).toPass();
    // Default showCompleted = true → the completed task is still listed.
    await expect(page.getByText('Finished chore', { exact: true }).first()).toBeVisible();

    // Open Display and turn "Completed tasks" OFF.
    await openDisplay(page);
    await setDisplayCompletedToggle(page, false);
    await closeDisplay(page);
    // The completed task is now hidden.
    await expect(page.getByText('Finished chore', { exact: true })).toHaveCount(0);

    // Turn it back ON → the completed task reappears.
    await openDisplay(page);
    await setDisplayCompletedToggle(page, true);
    await closeDisplay(page);
    await expect(page.getByText('Finished chore', { exact: true }).first()).toBeVisible();
  });
});
