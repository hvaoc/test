import { test, expect } from './helpers';

/**
 * Smart lists: the sidebar exposes all eight built-in lists, and clicking each
 * navigates and shows its header (the same label rendered large in the content
 * pane, next to its icon).
 */
const SMART_LISTS = [
  'Inbox',
  'Today',
  'Upcoming',
  'Overdue',
  'Anytime',
  'Someday',
  'Logbook',
  'Trash',
];

test.describe('Smart lists', () => {
  test('sidebar lists all built-in smart lists', async ({ page }) => {
    for (const label of SMART_LISTS) {
      // Each appears at least once (in the sidebar).
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test('clicking each smart list navigates and shows its header', async ({ page }) => {
    for (const label of SMART_LISTS) {
      await page.getByText(label, { exact: true }).first().click();
      await page.waitForTimeout(200);
      // After navigating, the label appears at least twice: sidebar row + the
      // large content-pane header. That confirms we're on that list's screen.
      await expect(async () => {
        const count = await page.getByText(label, { exact: true }).count();
        expect(count).toBeGreaterThanOrEqual(2);
      }).toPass();
    }
  });
});
