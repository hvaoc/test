import {
  test,
  expect,
  createTask,
  openTask,
  openSmartList,
  closeDetail,
  createProject,
  createArea,
  clickDetailField,
} from './helpers';

/**
 * Organization: Areas, Projects, Headings (sections), moving a task into a
 * project, and tagging a task.
 */
test.describe('Organization', () => {
  test('create an Area (appears in the sidebar)', async ({ page }) => {
    await createArea(page, 'Personal');
    await expect(page.getByText('Personal', { exact: true }).first()).toBeVisible();
  });

  test('create a Project (appears in the sidebar and opens)', async ({ page }) => {
    await createProject(page, 'Website Redesign');
    await page.getByText('Website Redesign', { exact: true }).first().click();
    await page.waitForTimeout(400);
    // The project header renders the name in an editable TextInput (placeholder
    // "Project name"), so assert on that input's value rather than a Text node.
    await expect(page.getByPlaceholder('Project name').first()).toHaveValue('Website Redesign');
    // And the project view offers the inline "Add task" affordance.
    await expect(page.getByText('Add task', { exact: true }).first()).toBeVisible();
  });

  test('add a Heading (section) to a project', async ({ page }) => {
    await createProject(page, 'Launch Plan');
    await page.getByText('Launch Plan', { exact: true }).first().click();
    await page.waitForTimeout(400);

    // The "Add section" trigger is hover-revealed but always clickable.
    const addSection = await page.evaluateHandle(() =>
      [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && e.textContent === 'Add section'
      ) || null
    );
    const el = addSection.asElement();
    expect(el).not.toBeNull();
    await el!.click({ force: true });

    await page.getByPlaceholder('Section name').fill('Phase 1');
    await page.getByText('Save', { exact: true }).first().click();
    await expect(page.getByText('Phase 1', { exact: true }).first()).toBeVisible();
  });

  test('add a task to a project via the inline composer', async ({ page }) => {
    await createProject(page, 'Backlog');
    await page.getByText('Backlog', { exact: true }).first().click();
    await page.waitForTimeout(400);

    // Projects use an inline "+ Add task" row (TaskComposer), not the FAB.
    await page.getByText('Add task', { exact: true }).first().click();
    await page.getByPlaceholder('Task name').fill('Research competitors');
    // The composer's submit button is also labelled "Add task".
    await page.getByText('Add task', { exact: true }).last().click();
    await expect(page.getByText('Research competitors', { exact: true }).first()).toBeVisible();
  });

  test('move a task into a project via the detail Project field', async ({ page }) => {
    await createProject(page, 'Ops');

    // Create the task in the Inbox first.
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Rotate API keys');

    // Open it and reassign via the "Project" FieldRow → MoveSheet (a BottomSheet
    // whose option Pressables respond to normal clicks).
    await openTask(page, 'Rotate API keys');
    await clickDetailField(page, 'Project');
    await expect(page.getByText('Move To', { exact: true })).toBeVisible();
    await page.getByText('Ops', { exact: true }).last().click(); // the sheet option
    await closeDetail(page);

    // It now lives inside the Ops project.
    await page.getByText('Ops', { exact: true }).first().click();
    await expect(page.getByText('Rotate API keys', { exact: true }).first()).toBeVisible();

    // And it left the Inbox.
    await openSmartList(page, 'Inbox');
    await expect(page.getByText('Rotate API keys', { exact: true })).toHaveCount(0);
  });

  test('add a Tag to a task and see the badge on its row', async ({ page }) => {
    await openSmartList(page, 'Inbox');
    await createTask(page, 'Tagged task');

    await openTask(page, 'Tagged task');
    await clickDetailField(page, 'Labels');
    // The TagSheet: type a new tag and Add it (also selects it for this task).
    await page.getByPlaceholder('New tag…').fill('urgent');
    await page.getByText('Add', { exact: true }).first().click();
    await expect(page.getByText('urgent', { exact: true }).first()).toBeVisible();
    // Close the tag sheet, then the detail editor.
    await page.getByText('Done', { exact: true }).first().click();
    await closeDetail(page);

    // The row now shows the "urgent" tag badge.
    await expect(page.getByText('urgent', { exact: true }).first()).toBeVisible();
  });
});
