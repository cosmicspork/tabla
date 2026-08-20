import { chromium } from '@playwright/test';
const OUT = process.env.OUT!;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
for (const [path, name] of [['/settings', 'hub'], ['/settings/about', 'about'], ['/settings/notifications', 'notif'], ['/settings/appearance', 'appear']] as const) {
  await page.goto('http://127.0.0.1:8787' + path);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
// Dark, chosen explicitly.
await page.goto('http://127.0.0.1:8787/settings/appearance');
await page.getByTestId('theme-dark').click();
await page.waitForTimeout(400);
await page.goto('http://127.0.0.1:8787/settings');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/hub-dark.png` });
await browser.close();
