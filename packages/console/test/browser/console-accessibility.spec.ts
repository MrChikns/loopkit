import { expect, test, type Page } from '@playwright/test';

type RouteCase = {
  path: string;
  status?: number;
};

const routes: RouteCase[] = [
  { path: '/command' },
  { path: '/work' },
  { path: '/acceptance' },
  { path: '/health' },
  { path: '/company' },
  { path: '/observability' },
  { path: '/threads' },
  { path: '/threads/EXT-42' },
  { path: '/item/WI-001' },
  { path: '/timeline' },
  { path: '/activity' },
  { path: '/not-a-route', status: 404 },
];

type ContrastFailure = {
  selector: string;
  text: string;
  ratio: number;
  required: number;
  foreground: string;
  background: string;
};

async function computedContrastFailures(page: Page): Promise<ContrastFailure[]> {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];

    function rgba(value: string): Rgba | null {
      const match = value.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)/);
      if (!match) return null;
      return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? 1 : Number(match[4]),
      ];
    }

    function composite(top: Rgba, bottom: Rgba): Rgba {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
        alpha,
      ];
    }

    function background(element: Element): Rgba {
      const layers: Rgba[] = [];
      let current: Element | null = element;
      while (current) {
        const layer = rgba(getComputedStyle(current).backgroundColor);
        if (layer && layer[3] > 0) layers.push(layer);
        current = current.parentElement;
      }
      let result: Rgba = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i -= 1) result = composite(layers[i]!, result);
      return result;
    }

    function luminance(color: Rgba): number {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return channel(color[0]) * 0.2126 + channel(color[1]) * 0.7152 + channel(color[2]) * 0.0722;
    }

    function ratio(a: Rgba, b: Rgba): number {
      const lighter = Math.max(luminance(a), luminance(b));
      const darker = Math.min(luminance(a), luminance(b));
      return (lighter + 0.05) / (darker + 0.05);
    }

    function selector(element: Element): string {
      const html = element as HTMLElement;
      if (html.id) return `#${html.id}`;
      const classes = [...html.classList].slice(0, 2);
      return `${html.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join('')}`;
    }

    const candidates = [...document.querySelectorAll<HTMLElement>('body *')].filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (!element.getClientRects().length) return false;
      return [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
    });

    return candidates.flatMap((element) => {
      const style = getComputedStyle(element);
      const foregroundRaw = rgba(style.color);
      if (!foregroundRaw || foregroundRaw[3] === 0) return [];
      const backdrop = background(element);
      const foreground = composite(foregroundRaw, backdrop);
      const actual = ratio(foreground, backdrop);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      if (actual + 0.05 >= required) return [];
      return [{
        selector: selector(element),
        text: element.innerText.trim().replace(/\s+/g, ' ').slice(0, 80),
        ratio: Number(actual.toFixed(2)),
        required,
        foreground: style.color,
        background: `rgb(${backdrop.slice(0, 3).map((value) => Math.round(value)).join(', ')})`,
      }];
    });
  });
}

async function checkRoute(page: Page, route: RouteCase): Promise<void> {
  const response = await page.goto(route.path);
  expect(response?.status(), `${route.path} HTTP status`).toBe(route.status ?? 200);

  const headings = page.getByRole('heading');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');

  const headingLevels = await headings.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.tagName.slice(1))),
  );
  for (let index = 1; index < headingLevels.length; index += 1) {
    expect(
      headingLevels[index]! - headingLevels[index - 1]!,
      `${route.path} heading sequence ${headingLevels.join(' → ')}`,
    ).toBeLessThanOrEqual(1);
  }

  const unnamedControls = await page.locator('a:visible, button:visible, input:visible, textarea:visible, select:visible, summary:visible')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const html = element as HTMLElement;
        const labelledBy = html.getAttribute('aria-labelledby');
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
          : '';
        const input = element as HTMLInputElement;
        const labelText = input.labels ? [...input.labels].map((label) => label.textContent ?? '').join(' ') : '';
        const name = [
          html.getAttribute('aria-label'),
          labelledText,
          labelText,
          html.innerText,
          input.alt,
          input.title,
          input.placeholder,
          input.value && input.type === 'submit' ? input.value : '',
        ].filter(Boolean).join(' ').trim();
        return name ? [] : [`${html.tagName.toLowerCase()}.${[...html.classList].join('.')}`];
      }),
    );
  expect(unnamedControls, `${route.path} unnamed interactive controls`).toEqual([]);

  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(layout.document, `${route.path} document horizontal overflow`).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.body, `${route.path} body horizontal overflow`).toBeLessThanOrEqual(layout.viewport + 1);

  const undersizedTargets = await page.locator([
    'button:visible',
    'input:visible',
    'textarea:visible',
    'select:visible',
    'summary:visible',
    'a.opsui-rail__item:visible',
    'a.opsui-bottomnav__item:visible',
    'a.opsui-bottomsheet__item:visible',
    'a.opsui-btn:visible',
    'a.opsui-chip:visible',
    'a.opsui-topbar__crumb:visible',
    'a.opsui-eventrow__metaitem--link:visible',
    'a.opsui-dref:visible',
    'a.opsui-opsparks__note-link:visible',
    'a.opsui-composer__captured-link:visible',
    'a.opsui-intent-strip__link:visible',
    '.opsui-empty > a:visible',
    '.opsui-work__park-note a:visible',
    'a.opsui-provenance__chip:visible',
    '.opsui-eventrow__actions a:visible',
  ].join(', ')).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width + 0.5 >= 24 && rect.height + 0.5 >= 24
        ? []
        : [{
            target: `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`,
            width: Number(rect.width.toFixed(1)),
            height: Number(rect.height.toFixed(1)),
          }];
    }),
  );
  expect(undersizedTargets, `${route.path} targets below 24 × 24 CSS px`).toEqual([]);

  expect(await computedContrastFailures(page), `${route.path} computed text contrast`).toEqual([]);
}

for (const route of routes) {
  test(`${route.path} has a robust rendered accessibility contract`, async ({ page }) => {
    await checkRoute(page, route);
  });
}

test('palette keyboard flow filters, navigates, closes, and restores focus', async ({ page }) => {
  await page.goto('/command');
  const trigger = page.getByRole('button', { name: 'Open command palette' });
  await trigger.focus();
  await trigger.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  const search = page.getByRole('combobox', { name: 'Search commands and destinations' });
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('Analytics');
  await expect(dialog.getByRole('button', { name: /^Analytics\b/ })).toBeVisible();
  await search.press('End');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/observability$/);

  await page.goto('/command');
  await trigger.focus();
  await page.keyboard.press('Control+K');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('intent dialog is keyboard reachable and restores focus when dismissed', async ({ page }) => {
  await page.goto('/command');
  const trigger = page.getByRole('button', { name: 'Drop intent' });
  await trigger.focus();
  await trigger.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Drop intent' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
});

test('keyboard focus remains visible and unobscured through the shared shell', async ({ page }) => {
  await page.goto('/command');
  await page.locator('body').click({ position: { x: 1, y: 1 } });

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    const focusState = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      active.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = active.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      const style = getComputedStyle(active);
      return {
        target: `${active.tagName.toLowerCase()}.${[...active.classList].join('.')}`,
        inViewport:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= -1 &&
          rect.top >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          rect.bottom <= window.innerHeight + 1,
        unobscured: Boolean(top && (top === active || active.contains(top) || top.contains(active))),
        hasVisibleFocus:
          style.outlineStyle !== 'none' ||
          style.boxShadow !== 'none' ||
          style.borderColor !== 'rgba(0, 0, 0, 0)',
      };
    });
    expect(focusState, `Tab stop ${index + 1}`).not.toBeNull();
    expect(focusState?.inViewport, focusState?.target).toBe(true);
    expect(focusState?.unobscured, focusState?.target).toBe(true);
    expect(focusState?.hasVisibleFocus, focusState?.target).toBe(true);
  }
});

test('mobile overflow dialog opens and returns focus to More', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile navigation only');
  await page.goto('/command');
  const more = page.getByRole('button', { name: 'More destinations' });
  await more.focus();
  await more.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'More destinations' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
});

test('light theme retains computed contrast', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/command');
  await page.getByRole('button', { name: 'Toggle colour theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await computedContrastFailures(page), 'light-theme computed text contrast').toEqual([]);
});

test('reduced-motion preference removes all active CSS motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/command');
  const moving = await page.locator('body *:visible').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const durations = `${style.animationDuration},${style.transitionDuration}`
        .split(',')
        .map((value) => Number.parseFloat(value) || 0);
      return durations.some((duration) => duration > 0)
        ? [{
            target: `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`,
            animationDuration: style.animationDuration,
            transitionDuration: style.transitionDuration,
          }]
        : [];
    }),
  );
  expect(moving).toEqual([]);
});
