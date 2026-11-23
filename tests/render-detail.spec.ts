import { expect, test } from '@playwright/test';
import { ClampToEdgeWrapping, RepeatWrapping, Texture } from 'three';
import { ASSETS, configureTexture } from '../src/assets';
import { collectErrors } from './helpers';

test('longitude wraps without repeating the latitude or Saturn ring radius', () => {
  for (const name of Object.keys(ASSETS)) {
    const texture = new Texture();
    configureTexture(texture, name, 4);
    expect(texture.wrapS, name).toBe(
      name === 'saturn-rings' ? ClampToEdgeWrapping : RepeatWrapping,
    );
    expect(texture.wrapT, name).toBe(ClampToEdgeWrapping);
  }
});

test('high-quality Sagittarius A* observation uses the full drawing buffer', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/?quality=high#sagittarius-a');
  await expect
    .poll(() => page.evaluate(() => window.__horizon?.render()?.tier))
    .toBe('high');
  await expect
    .poll(() => page.evaluate(() => window.__horizon?.render()?.horizonSize))
    .toEqual([page.viewportSize()!.width, page.viewportSize()!.height]);
  await expect(page.locator('html')).toHaveAttribute('data-textures', 'ready');
  const frames = () => page.evaluate(() => window.__horizon!.frames());
  const start = await frames();
  await expect.poll(frames).toBeGreaterThan(start);
  expect(errors).toEqual([]);
});

test('Voyager loads its bundled model during observation', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/#voyager');
  await expect
    .poll(() => page.evaluate(() => window.__horizon?.render()?.voyagerModel))
    .toBe(true);
  expect(errors).toEqual([]);
});
