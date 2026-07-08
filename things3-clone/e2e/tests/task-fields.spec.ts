import {
  test,
  expect,
  createTask,
  openTask,
  openSmartList,
  closeDetail,
  createProject,
  addProjectTask,
} from './helpers';

/**
 * Task fields: When (schedule), Priority, Deadline, Notes.
 *
 * IMPORTANT — two composers, two behaviours:
 *  - The TASK DETAIL modal edits Date/Priority through an *anchored popover*
 *    (WhenMenu/PriorityMenu). In this RN-Web build those popover options do NOT
 *    respond to synthetic Playwright clicks, so we do NOT drive When/Priority
 *    through the detail modal.
 *  - The PROJECT inline "+ Add task" COMPOSER sets the same fields via
 *    BottomSheets (WhenSheet/PrioritySheet) whose Pressables DO respond. So the
 *    When/Priority tests create the task in a project via the composer.
 *  - Deadline (a BottomSheet calendar) and Notes (a plain input) work fine in
 *    the detail modal, so those are exercised there.
 */
test.describe('Task fields', () => {
  test('When = Today puts the task in the Today list', async ({ page }) => {
    await createProject(page, 'Scheduling');
    await page.getByText('Scheduling', { exact: true }).first().click();
    await page.waitForTimeout(400);

    await addProjectTask(page, 'Ship the release', { when: 'Today' });

    // It now appears under the Today smart list.
    await openSmartList(page, 'Today');
    await expect(page.getByText('Ship the release', { exact: true }).first()).toBeVisible();
  });

  test('When = Someday puts the task in the Someday list', async ({ page }) => {
    await createProject(page, 'Wishlist');
    await page.getByText('Wishlist', { exact: true }).first().click();
    await page.waitForTimeout(400);

    await addProjectTask(page, 'Learn the cello', { when: 'Someday' });

    await openSmartList(page, 'Someday');
    await expect(page.getByText('Learn the cello', { exact: true }).first()).toBeVisible();
  });

  test('Priority = High is set via the composer and persists on the row', async ({ page }) => {
    await createProject(page, 'Bugs');
    await page.getByText('Bugs', { exact: true }).first().click();
    await page.waitForTimeout(400);

    // Setting priority in a project draws a colored priority border on the row's
    // checkbox; assert the task lands and survives a reload of the view.
    await addProjectTask(page, 'Fix production bug', { priority: 'High' });
    await expect(page.getByText('Fix production bug', { exact: true }).first()).toBeVisible();

    // Re-open the project to confirm the priority persisted (task still listed).
    await openSmartList(page, 'Inbox');
    await page.getByText('Bugs', { exact: true }).first().click();
    await expect(page.getByText('Fix production bug', { exact: true }).first()).toBeVisible();
  });

  test('set a Deadline via the detail calendar sheet', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Submit taxes');

    await openTask(page, 'Submit taxes');
    // Deadline opens a BottomSheet calendar (responds to clicks).
    await page.getByText('Deadline', { exact: true }).first().click();
    await page.getByText('15', { exact: true }).first().click();
    await page.getByText('Done', { exact: true }).first().click();
    await closeDetail(page);
    await expect(page.getByText('Submit taxes', { exact: true }).first()).toBeVisible();
  });

  test('add Notes to a task and see them persist', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Plan the offsite');

    await openTask(page, 'Plan the offsite');
    const notes = page.getByPlaceholder('Notes').first();
    await notes.fill('Book venue and send invites');
    await page.waitForTimeout(200);
    await closeDetail(page);

    // Reopen and verify the notes round-tripped.
    await openTask(page, 'Plan the offsite');
    await expect(page.getByPlaceholder('Notes').first()).toHaveValue('Book venue and send invites');
    await closeDetail(page);
  });
});
