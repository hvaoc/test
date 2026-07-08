import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:8088', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
const dump = async (t) => console.log(t, (await p.$$eval('[data-testid]', e=>[...new Set(e.map(x=>x.getAttribute('data-testid')))])).sort().join(', '));
await dump('before:');
// FAB is bottom-right; click it robustly
await p.click('[data-testid="fab-add-task"]', { force: true });
await p.waitForTimeout(2000);
await dump('after FAB:');
