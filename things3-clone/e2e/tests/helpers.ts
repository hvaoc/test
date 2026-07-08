import { test as base, expect, Page, Locator } from '@playwright/test';

/**
 * ---------------------------------------------------------------------------
 * RESET STRATEGY (repeatable / isolated tests)
 * ---------------------------------------------------------------------------
 * The app is offline-first and persists its workspace client-side:
 *   - IndexedDB `things3clone-ydoc`  → the CRDT record store (tasks, projects,
 *     areas, headings, tags, custom views). Written by public/crdt.worker.js.
 *   - localStorage keys `appFg`/`appBg`/`appZoom` and `things3clone:data:v2`
 *     → UI prefs + a fallback snapshot.
 *
 * On hydrate (src/store/TasksContext.js) an EMPTY store yields an EMPTY
 * workspace — there is NO auto-seeded sample data. So a pristine origin === a
 * known baseline.
 *
 * Playwright already gives every test a brand-new browser context (fresh
 * IndexedDB + localStorage), which is the primary isolation boundary. On top of
 * that we defensively wipe all client storage for the origin in `resetApp()`
 * BEFORE the app boots, then load the page — so even a reused profile or a
 * leaked worker DB can't bleed state across tests. Each spec then creates the
 * exact data it asserts on.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8088';

/**
 * Boot into a clean, empty offline workspace and wait until it's ready for
 * writes.
 *
 * Playwright gives every test a brand-new browser context, so IndexedDB /
 * localStorage / OPFS for the origin start empty — that fresh context IS the
 * isolation boundary and the known baseline (an empty store hydrates to an
 * empty workspace; there is no auto-seeded sample data). We also defensively
 * clear localStorage + any IndexedDB the origin already has, in case a reused
 * profile leaked prefs. We deliberately do NOT try to wipe OPFS or force-delete
 * a live worker DB: that races the record worker's init and silently drops the
 * first structural write.
 *
 * Critically, the CRDT record worker (WASM + OPFS/IndexedDB) initializes
 * asynchronously after the shell renders; structural writes (new Area /
 * Project / Heading) issued before it's ready are lost. We wait for the sidebar
 * shell AND a short settle so the worker is accepting writes before any test
 * touches the store.
 */
export async function resetApp(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
    try {
      const dbs = (await (indexedDB as any).databases?.()) || [];
      dbs.forEach((d: any) => d?.name && indexedDB.deleteDatabase(d.name));
    } catch {}
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Things', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  // Sidebar smart lists confirm the shell hydrated.
  await expect(page.getByText('Inbox', { exact: true }).first()).toBeVisible();
  // Let the record worker finish initializing so the first structural write
  // (Area/Project/Heading) isn't dropped. See docstring above.
  await page.waitForTimeout(1500);
}

/** Navigate to a smart list by its sidebar label (Inbox, Today, ...). */
export async function openSmartList(page: Page, label: string) {
  await page.getByText(label, { exact: true }).first().click();
  // The list header renders the same label (larger). Give it a beat to swap.
  await page.waitForTimeout(250);
}

/**
 * Click the round "Magic Plus" floating action button (bottom-right).
 * RN-Web renders it as a styled <div> with no role/testid, so we locate it by
 * its distinctive computed style (round + accent blue + bottom-right) and click
 * the real element. Creates a new to-do in the current list and opens its
 * detail editor.
 */
export async function clickFab(page: Page) {
  const handle = await page.evaluateHandle(() => {
    const w = innerWidth, h = innerHeight;
    let best: Element | null = null;
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const round =
        parseFloat(s.borderRadius) >= r.width / 2 - 2 &&
        r.width >= 40 && r.width <= 72 &&
        Math.abs(r.width - r.height) < 4;
      if (round && r.right > w - 110 && r.bottom > h - 170 && s.backgroundColor === 'rgb(43, 111, 255)') {
        best = el;
      }
    });
    return best;
  });
  const el = handle.asElement();
  if (!el) throw new Error('Floating add button (FAB) not found on the page');
  await el.click();
}

/**
 * Create a task in the current list and set its title via the detail editor,
 * then close the editor. Returns after the row is visible in the list.
 */
export async function createTask(page: Page, title: string) {
  await clickFab(page);
  const input = page.getByPlaceholder('New To-Do').first();
  await input.waitFor({ state: 'visible' });
  await input.fill(title);
  await page.waitForTimeout(150); // let the debounced store write settle
  await closeDetail(page);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
}

/**
 * Click a FieldRow in the task detail editor by its label (Project / Date /
 * Deadline / Priority / Labels / Location). In the wide layout the fields sit
 * in a right-hand panel that a sibling ScrollView can overlap, so we resolve
 * the row's Pressable ancestor and click the element directly (bypassing
 * pointer-interception flakiness).
 */
export async function clickDetailField(page: Page, label: string) {
  const handle = await page.evaluateHandle((t) => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent === t
    );
    if (!leaf) return null;
    // Climb to the nearest pointer (Pressable) ancestor.
    let n: Element | null = leaf;
    for (let i = 0; i < 6 && n; i++) {
      if (getComputedStyle(n as Element).cursor === 'pointer') return n;
      n = n.parentElement;
    }
    return leaf;
  }, label);
  const el = handle.asElement();
  if (!el) throw new Error(`detail field "${label}" not found`);
  await el.click({ force: true });
}

/** Open a task's detail editor by clicking its row title. */
export async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.getByPlaceholder('New To-Do').first()).toBeVisible();
}

/**
 * Close the task detail editor by clicking its back chevron. In the wide /
 * split layout the detail opens as the right-hand pane, so its top bar sits to
 * the right of the sidebar (not at window x=0). We click the left-most small
 * pointer element in the detail pane's top band (the chevron-back).
 */
export async function closeDetail(page: Page) {
  const handle = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('*')] as HTMLElement[];
    let best: Element | null = null, bestX = 1e9;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      // Detail top bar band; back chevron is the left-most action, but to the
      // right of the ~285px sidebar so we don't grab a sidebar row.
      if (r.top < 46 && r.width >= 16 && r.width <= 40 && r.height >= 16 && r.height <= 40 &&
          r.left > 285 && r.left < 700 && s.cursor === 'pointer') {
        if (r.left < bestX) { bestX = r.left; best = el; }
      }
    });
    return best;
  });
  const el = handle.asElement();
  if (el) await el.click();
  else await page.keyboard.press('Escape'); // fallback (narrow layout)
  await expect(page.getByPlaceholder('New To-Do')).toHaveCount(0, { timeout: 10_000 });
}

/**
 * The checkbox on a task row is an unlabelled Pressable rendered just left of
 * the title. Toggle it by clicking a point a bit to the left of the title text.
 */
export async function toggleTaskCheckbox(page: Page, title: string) {
  const row = page.getByText(title, { exact: true }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error(`row "${title}" not found for checkbox toggle`);
  await page.mouse.click(box.x - 22, box.y + box.height / 2);
}

/**
 * Toggle a task's row checkbox in a PROJECT view. Project rows have a chevron
 * gutter left of the checkbox, so we pick the RIGHT-most small pointer element
 * on the row's baseline (that's the checkbox, not the gutter).
 */
export async function toggleProjectTaskCheckbox(page: Page, title: string) {
  const row = page.getByText(title, { exact: true }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error(`row "${title}" not found`);
  const point = await page.evaluate((y) => {
    let best: { x: number; y: number } | null = null, bestRight = -1;
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (Math.abs((r.top + r.height / 2) - y) < 16 &&
          r.width >= 16 && r.width <= 30 && r.height >= 16 && r.height <= 30 &&
          s.cursor === 'pointer' && r.left < 600) {
        if (r.left > bestRight) { bestRight = r.left; best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
      }
    });
    return best;
  }, box.y + box.height / 2);
  if (!point) throw new Error(`checkbox for "${title}" not found`);
  await page.mouse.click(point.x, point.y);
}

/**
 * Read the "Completed tasks" toggle in the project Display popover and set it to
 * `on`. The popover must already be open. Returns nothing; asserts the switch
 * was found. RN-Web renders the Switch as <input type=checkbox role=switch>.
 */
export async function setDisplayCompletedToggle(page: Page, on: boolean) {
  const sw = await page.evaluate(() => {
    const lbl = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent === 'Completed tasks'
    ) as HTMLElement | undefined;
    if (!lbl) return null;
    const lr = lbl.getBoundingClientRect();
    const el = [...document.querySelectorAll('input[type=checkbox][role=switch]')].find((s) => {
      const r = s.getBoundingClientRect();
      return Math.abs((r.top + r.height / 2) - (lr.top + lr.height / 2)) < 24 && r.left > lr.right;
    }) as HTMLInputElement | undefined;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { checked: el.checked, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!sw) throw new Error('"Completed tasks" toggle not found in Display popover');
  if (sw.checked !== on) await page.mouse.click(sw.x, sw.y);
}

/** Open the "New List" sheet (create Project / Area) via the sidebar header +. */
export async function openNewListSheet(page: Page) {
  const handle = await page.evaluateHandle(() => {
    const els = [...document.querySelectorAll('*')] as HTMLElement[];
    const title = els.find(
      (e) => e.textContent === 'Things' && e.getBoundingClientRect().width < 140 && e.getBoundingClientRect().top < 90
    );
    if (!title) return null;
    const tr = title.getBoundingClientRect();
    let best: Element | null = null, bestd = 1e9;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width >= 16 && r.width <= 44 && r.height >= 16 && r.height <= 44 && r.top < 90 && r.left > tr.right) {
        const d = r.left - tr.right;
        if (d < bestd) { bestd = d; best = el; }
      }
    });
    return best;
  });
  const el = handle.asElement();
  if (!el) throw new Error('Sidebar header "+" (New List) not found');
  await el.click();
  await expect(page.getByText('New List', { exact: true })).toBeVisible();
}

/**
 * Add a task to the currently-open PROJECT via its inline "+ Add task" composer,
 * optionally setting scheduling / priority through the composer's field chips
 * (which open BottomSheets — reliable, unlike the detail modal's anchored
 * WhenMenu/PriorityMenu popovers that don't respond to synthetic clicks).
 *
 * `when` ∈ 'Today' | 'This Evening' | 'Someday'; `priority` ∈ 'High'|'Medium'|'Low'.
 * The composer must be reachable (an open project view).
 */
export async function addProjectTask(
  page: Page,
  title: string,
  opts: { when?: string; priority?: string } = {}
) {
  await page.getByText('Add task', { exact: true }).first().click();
  await page.getByPlaceholder('Task name').fill(title);

  if (opts.when) {
    // The scheduling chip is labelled "Date" until set.
    await page.getByText('Date', { exact: true }).first().click();
    // WhenSheet option (bottom sheet) — the right-most match is the sheet.
    await page.getByText(opts.when, { exact: true }).last().click();
    await page.waitForTimeout(200);
  }
  if (opts.priority) {
    await page.getByText('Priority', { exact: true }).first().click();
    await page.getByText(opts.priority, { exact: true }).last().click();
    await page.waitForTimeout(200);
  }

  // Submit: the composer's confirm button is also labelled "Add task".
  await page.getByText('Add task', { exact: true }).last().click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
}

/** Create a Project via the New List sheet. Returns once it appears in sidebar. */
export async function createProject(page: Page, name: string) {
  await withCreateRetry(page, name, async () => {
    await openNewListSheet(page);
    // Default segment is "Project".
    await page.getByPlaceholder('Project name').fill(name);
    await page.getByText('Create Project', { exact: true }).click();
  });
}

/** Create an Area via the New List sheet. */
export async function createArea(page: Page, name: string) {
  await withCreateRetry(page, name, async () => {
    await openNewListSheet(page);
    await page.getByText('Area', { exact: true }).first().click(); // switch segment
    await page.getByPlaceholder('Area name').fill(name);
    await page.getByText('Create Area', { exact: true }).click();
  });
}

/**
 * Run a create action and confirm the named item appears in the sidebar. If the
 * record worker was still initializing and swallowed the first write, retry
 * once. Keeps Area/Project creation deterministic in CI.
 */
async function withCreateRetry(page: Page, name: string, doCreate: () => Promise<void>) {
  await doCreate();
  const appeared = await page
    .getByText(name, { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.waitForTimeout(1000);
    await doCreate();
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 8_000 });
  }
}

/** A test fixture that resets the app before each test. */
export const test = base.extend<{}>({
  page: async ({ page }, use) => {
    await resetApp(page);
    await use(page);
  },
});

export { expect, BASE };
export type { Page, Locator };
