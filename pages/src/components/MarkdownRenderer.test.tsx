// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, useTranslation } from '../i18n';
import { en } from '../i18n/en';
import { ja } from '../i18n/ja';
import { ru } from '../i18n/ru';
import type { Language } from '../i18n/types';
import { extractHeadings } from '../utils/extractHeadings';
import MarkdownRenderer from './MarkdownRenderer';

// The headings are Russian on purpose: explicit heading IDs exist for text that
// cannot produce a usable ASCII slug on its own. Held in constants rather than
// inline, because a marker comment on the JSX line would render as heading text.
const H2 = 'Что делает навык'; // allow-non-english: fixture heading that cannot produce an ASCII slug
const H4 = 'Публикация'; // allow-non-english: fixture heading that cannot produce an ASCII slug
const CONTENT = `## ${H2} {#what-the-skill-does}\n\n#### ${H4} {#service-account}`;
const H2_LOCALE_SLUG = 'что-делает-навык'; // allow-non-english: the localized slug the heading above keeps as an alias

/** Render inside the language provider, optionally in a non-English locale. */
function renderMarkdown(content: string, language?: string) {
  if (language) localStorage.setItem('ocr-lang', language);
  return render(
    <LanguageProvider>
      <MarkdownRenderer content={content} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  localStorage.removeItem('ocr-lang');
});

describe('MarkdownRenderer heading IDs', () => {
  it('renders an explicit heading ID without displaying its marker', () => {
    render(
      <LanguageProvider>
        <MarkdownRenderer content={CONTENT} />
      </LanguageProvider>,
    );

    const heading = screen.getByRole('heading', { name: H2 });
    expect(heading.getAttribute('id')).toBe('what-the-skill-does');
    expect(heading.textContent).not.toContain('{#what-the-skill-does}');
    expect(screen.getByRole('heading', { name: H4, level: 4 }).getAttribute('id')).toBe('service-account');
  });

  it('renders unique IDs for repeated headings', () => {
    render(
      <LanguageProvider>
        <MarkdownRenderer content={'## Schema\n\n## Schema\n\n### Output\n\n### Output'} />
      </LanguageProvider>,
    );

    expect(screen.getAllByRole('heading', { name: 'Schema' }).map((heading) => heading.id)).toEqual([
      'schema',
      'schema-2',
    ]);
    expect(screen.getAllByRole('heading', { name: 'Output' }).map((heading) => heading.id)).toEqual([
      'output',
      'output-2',
    ]);
  });

  it('keeps rendered heading IDs aligned with the TOC extraction', () => {
    const content = [
      'Setext title',
      '=============',
      '',
      '## Schema',
      '',
      '~~~',
      '## Fake heading inside a code block',
      '~~~',
      '',
      '## Schema',
      '### Output',
      '### Output',
    ].join('\n');
    const { container } = render(
      <LanguageProvider>
        <MarkdownRenderer content={content} />
      </LanguageProvider>,
    );

    const renderedTocHeadingIds = Array.from(container.querySelectorAll('h2, h3')).map((heading) => heading.id);
    expect(renderedTocHeadingIds).toEqual(extractHeadings(content).map(({ id }) => id));
  });

  it('keeps an alias target for a heading whose ID an explicit marker owns', () => {
    const { container } = renderMarkdown(CONTENT);

    const alias = container.querySelector(`#${CSS.escape(H2_LOCALE_SLUG)}`);
    expect(alias).not.toBeNull();
    expect(alias?.textContent).toBe('');
    expect(alias?.closest('h2')?.id).toBe('what-the-skill-does');
    expect(screen.getByRole('heading', { name: H2 }).textContent).toBe(H2);
  });
});

describe('MarkdownRenderer inline markup in headings', () => {
  it('renders backticked heading text as a code element instead of literal backticks', () => {
    const { container } = renderMarkdown('## `code_search`\n\n## `file_read_diff` {#filereaddiff}');

    const [codeSearch, fileReadDiff] = Array.from(container.querySelectorAll('h2'));
    expect(codeSearch.textContent).toBe('code_search');
    expect(codeSearch.querySelector('code')?.textContent).toBe('code_search');
    expect(container.innerHTML).not.toContain('`');
    expect(screen.getByRole('heading', { name: 'code_search' })).toBe(codeSearch);
    // An explicit marker is metadata: it sets the ID and never reaches the page.
    expect(fileReadDiff.id).toBe('filereaddiff');
    expect(fileReadDiff.textContent).toBe('file_read_diff');
  });

  it('scales heading code with the heading rather than with body text', () => {
    const { container } = renderMarkdown('## `code_search`\n\nBody with `code_search` inline.');

    const headingCode = container.querySelector('h2 code');
    expect(headingCode?.getAttribute('style')?.replace(/\s/g, '')).toBe('font-size:inherit');
    // Heading code carries the heading class alone: the nowrap budget is a
    // body-text measurement and does not describe a chip rendered at 20px.
    expect(headingCode?.className).toBe('docs-heading-code');
    // Body code keeps the stylesheet's own sizing.
    const bodyCode = container.querySelector('p code');
    expect(bodyCode?.getAttribute('style')).toBeNull();
    expect(bodyCode?.className).toBe('code-nowrap');
  });

  it('renders emphasis and links inside a heading as elements', () => {
    const { container } = renderMarkdown('### Read **this** and [that](../viewer/)');

    const heading = container.querySelector('h3');
    expect(heading?.querySelector('strong')?.textContent).toBe('this');
    expect(heading?.querySelector('a')?.getAttribute('href')).toBe('/docs/viewer');
    expect(heading?.textContent).toBe('Read this and that');
  });
});

describe('MarkdownRenderer documentation links', () => {
  const LINKS = [
    '[Architecture](../architecture/)',
    '[JSON](../cli-reference/#json)',
    '[Delegate](../integrations/delegate/)',
    '[Nested](../../review-rules/)',
    '[Completion](./cli-reference.md#ocr-completion)',
    '[CI](../ci/)',
    '[Upstream](https://example.com/a/tools/)',
    '[Same page](#limits)',
    '[No slug](../#tips-that-apply-to-every-pattern)',
    '[Asset](/images/blog/demo.png)',
  ].join('\n\n');

  it('rewrites relative doc links to the route that serves them and leaves the rest alone', () => {
    const { container } = renderMarkdown(LINKS);

    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/architecture',
      '/docs/cli-reference#json',
      '/docs/delegate',
      '/docs/review-rules',
      '/docs/cli-reference#ocr-completion',
      '/docs/cicd',
      'https://example.com/a/tools/',
      '#limits',
      '../#tips-that-apply-to-every-pattern',
      '/images/blog/demo.png',
    ]);
  });

  it('recognises a doc slug whatever case the link was written in', () => {
    const { container } = renderMarkdown('[Upper](../CI.md)\n\n[Mixed](../Cli-Reference/#json)');

    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/cicd',
      '/docs/cli-reference#json',
    ]);
  });

  it('keeps the link text and title untouched while rewriting the target', () => {
    const { container } = renderMarkdown('[Viewer](../viewer/ "Session viewer")');

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/docs/viewer');
    expect(link?.getAttribute('title')).toBe('Session viewer');
    expect(link?.textContent).toBe('Viewer');
  });
});

describe('MarkdownRenderer language of parts', () => {
  const CODE_CONTENT = 'Bullet with `git grep --max-count` inline.\n\n```sh\ngit grep\n```';

  it('marks inline code as English on a localized page', () => {
    const { container } = renderMarkdown(CODE_CONTENT, 'ru');

    const inlineCode = container.querySelector('p code');
    expect(inlineCode?.getAttribute('lang')).toBe('en');
    // Fenced blocks keep their language class and gain no lang attribute.
    const block = container.querySelector('pre code');
    expect(block?.getAttribute('lang')).toBeNull();
    expect(block?.className).toBe('language-sh');
  });

  it('adds no redundant lang attribute on the English page', () => {
    const { container } = renderMarkdown(CODE_CONTENT, 'en');

    expect(container.querySelector('p code')?.getAttribute('lang')).toBeNull();
  });
});

describe('MarkdownRenderer inline code wrapping', () => {
  // The bordered chip is repainted per line box, so a reference that fits the
  // prose column must not break; one that cannot fit still has to wrap, or it
  // would push the article sideways.
  const TRUNCATION_NOTE = 'Note: The results have been truncated. Only showing first 100 results.';
  // Exactly at the budget and exactly one column past it.
  const AT_BUDGET = 'x'.repeat(24);
  const OVER_BUDGET = 'x'.repeat(25);
  // Inline code from the localized docs: a CJK glyph is two monospace columns
  // wide, so 22 characters are 33 columns and stay wrappable, while a short
  // placeholder is well inside the budget.
  const ZH_LONG_CODE = '<会话 ID>-<任务类型>-<作用域哈希>'; // allow-non-english: inline code copied from the zh configuration doc
  const ZH_SHORT_CODE = '会话 ID'; // allow-non-english: inline code copied from the zh configuration doc

  /** Class names of every inline code span the markdown produced, in order. */
  function inlineCodeClasses(markdown: string, language?: string): string[] {
    const { container } = renderMarkdown(markdown, language);
    return Array.from(container.querySelectorAll('p code')).map((code) => code.className);
  }

  it('holds a short inline code reference on one line and lets a long one wrap', () => {
    expect(inlineCodeClasses(`Bullet with \`git grep --max-count\` and \`${TRUNCATION_NOTE}\`.`)).toEqual([
      'code-nowrap',
      '',
    ]);
  });

  it('treats the column budget as inclusive at its boundary', () => {
    expect(inlineCodeClasses(`\`${AT_BUDGET}\` then \`${OVER_BUDGET}\`.`)).toEqual(['code-nowrap', '']);
  });

  it('counts a wide CJK glyph as the two monospace columns it renders as', () => {
    expect(inlineCodeClasses(`\`${ZH_LONG_CODE}\` and \`${ZH_SHORT_CODE}\`.`)).toEqual(['', 'code-nowrap']);
  });

  it('counts the decoded text, so an escaped character is one column', () => {
    // 18 characters as authored; 35 in the HTML marked emits, because `&`, `<`
    // and `"` become entities. Counting the markup would push it over budget.
    expect(inlineCodeClasses('Redirect with `a & b < c "quoted"` here.')).toEqual(['code-nowrap']);
  });

  it('keeps the gate off heading code, which renders at the heading font size', () => {
    const { container } = renderMarkdown(
      '## `code_search`\n\n## `The results have been truncated`\n\nBody with `code_search` inline.',
      'ru',
    );

    const [short, long] = Array.from(container.querySelectorAll('h2 code'));
    // `font-size: inherit` renders this chip at the h2's 20px (28px in an h1),
    // where 24 columns is no longer the ~202px the budget was measured for, so a
    // nowrap chip could reach past a narrow column instead of wrapping in it.
    expect(short.className).toBe('docs-heading-code');
    expect(short.getAttribute('lang')).toBe('en');
    expect(short.getAttribute('style')?.replace(/\s/g, '')).toBe('font-size:inherit');
    expect(long.className).toBe('docs-heading-code');
    expect(long.getAttribute('style')?.replace(/\s/g, '')).toBe('font-size:inherit');
    // The very same text in body prose is inside the budget and is held.
    expect(container.querySelector('p code')?.className).toBe('code-nowrap');
  });

  it('leaves fenced code blocks out of the inline treatment', () => {
    const { container } = renderMarkdown('```sh\ngit grep\n```');

    expect(container.querySelector('pre code')?.className).toBe('language-sh');
  });
});

describe('MarkdownRenderer table scroll regions', () => {
  // A paragraph sits between the heading and the table on purpose: marked's
  // output is flat, so the heading that names the region is several previous
  // siblings back rather than the immediate one.
  const TABLE_CONTENT = [
    '## Tool availability',
    '',
    'Intro paragraph.',
    '',
    '| Tool | Phase |',
    '| --- | --- |',
    '| code_search | main |',
  ].join('\n');
  // The same table with no heading anywhere above it.
  const HEADLESS_TABLE_CONTENT = ['| Tool | Phase |', '| --- | --- |', '| code_search | main |'].join('\n');

  /**
   * jsdom reports 0 for both measurements, so overflow has to be stated: an own
   * property on the instance shadows the prototype getter the component reads.
   */
  function setMeasuredWidths(element: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true });
    Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true });
  }

  /** The four attributes the measurement owns, as the DOM currently holds them. */
  function regionAttributes(wrapper: HTMLElement) {
    return {
      tabindex: wrapper.getAttribute('tabindex'),
      role: wrapper.getAttribute('role'),
      labelledby: wrapper.getAttribute('aria-labelledby'),
      label: wrapper.getAttribute('aria-label'),
    };
  }

  const resizeWindow = () => fireEvent(window, new Event('resize'));

  it('leaves a wrapper that does not scroll out of the tab order entirely', () => {
    const { container } = renderMarkdown(TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('table')).not.toBeNull();
    expect(regionAttributes(wrapper as HTMLElement)).toEqual({
      tabindex: null,
      role: null,
      labelledby: null,
      label: null,
    });
    expect(container.querySelectorAll('[tabindex]').length).toBe(0);
  });

  it('emits the wrapper inert, so the markup itself plants no focus stop', () => {
    // The measurement below would strip a tabindex baked into the markup, which
    // hides it from the DOM assertions above. What it cannot hide is the removal
    // itself: taking an attribute off an element records a mutation with the old
    // value, while removing one that was never there records nothing.
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((entries) => records.push(...entries));
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['tabindex', 'role', 'aria-labelledby', 'aria-label'],
    });

    try {
      const { container } = renderMarkdown(TABLE_CONTENT);
      records.push(...observer.takeRecords());

      expect(container.querySelector('.table-scroll')).not.toBeNull();
      expect(records.map((record) => [(record.target as HTMLElement).className, record.attributeName])).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });

  it('makes an overflowing wrapper a named region and a Tab stop', () => {
    const { container } = renderMarkdown(TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    setMeasuredWidths(wrapper, 600, 300);
    resizeWindow();

    expect(regionAttributes(wrapper)).toEqual({
      tabindex: '0',
      role: 'region',
      labelledby: 'tool-availability',
      label: null,
    });
    // The label has to resolve to the section title the reader just passed.
    expect(document.getElementById('tool-availability')?.textContent).toBe('Tool availability');
  });

  it('chains the enclosing section heading into the name, so sibling tables differ', () => {
    // The shape of a tool reference: the same subsection title under two tools.
    // Named after the nearest heading alone, both tables would be "Schema".
    const content = [
      '## code_search',
      '',
      '### Schema',
      '',
      '| Field | Type |',
      '| --- | --- |',
      '| pattern | string |',
      '',
      '## file_find',
      '',
      '### Schema',
      '',
      '| Field | Type |',
      '| --- | --- |',
      '| glob | string |',
    ].join('\n');
    const { container } = renderMarkdown(content);

    const wrappers = Array.from(container.querySelectorAll<HTMLElement>('.table-scroll'));
    wrappers.forEach((wrapper) => setMeasuredWidths(wrapper, 600, 300));
    resizeWindow();

    const [toolOne, toolTwo] = Array.from(container.querySelectorAll('h2'));
    const [schemaOne, schemaTwo] = Array.from(container.querySelectorAll('h3'));
    expect(wrappers.map((wrapper) => wrapper.getAttribute('aria-labelledby'))).toEqual([
      `${toolOne.id} ${schemaOne.id}`,
      `${toolTwo.id} ${schemaTwo.id}`,
    ]);
    // Both IDs must resolve, or the name would be empty and the region unnamed.
    expect(wrappers[0].getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent)).toEqual([
      'code_search',
      'Schema',
    ]);
  });

  it('releases every attribute once the wrapper stops overflowing', () => {
    const { container } = renderMarkdown(TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    setMeasuredWidths(wrapper, 600, 300);
    resizeWindow();
    expect(wrapper.getAttribute('tabindex')).toBe('0');

    setMeasuredWidths(wrapper, 300, 300);
    resizeWindow();

    expect(regionAttributes(wrapper)).toEqual({
      tabindex: null,
      role: null,
      labelledby: null,
      label: null,
    });
  });

  it('treats a one-pixel difference as a table that fits', () => {
    const { container } = renderMarkdown(TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    setMeasuredWidths(wrapper, 301, 300);
    resizeWindow();

    expect(wrapper.getAttribute('tabindex')).toBeNull();
  });

  it('never drops the tabindex of the wrapper that holds focus', () => {
    const { container } = renderMarkdown(TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    setMeasuredWidths(wrapper, 600, 300);
    resizeWindow();
    wrapper.focus();
    expect(document.activeElement).toBe(wrapper);

    // A resize that removed the tabindex here would drop the reader to <body>.
    setMeasuredWidths(wrapper, 300, 300);
    resizeWindow();
    expect(wrapper.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(wrapper);

    // Focus traffic elsewhere in the article is not this wrapper's business:
    // bound to the whole container the listener would re-measure every wrapper
    // on each Tab press across a page of code blocks.
    fireEvent.focusOut(container.querySelector('h2') as HTMLElement);
    expect(wrapper.getAttribute('tabindex')).toBe('0');

    // The wrapper's own focusout is when releasing it costs nothing.
    wrapper.blur();
    fireEvent.focusOut(wrapper);
    expect(regionAttributes(wrapper)).toEqual({
      tabindex: null,
      role: null,
      labelledby: null,
      label: null,
    });
  });

  it('names the region from the table caption when no heading precedes it', () => {
    const { container } = renderMarkdown(HEADLESS_TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    const caption = document.createElement('caption');
    caption.textContent = 'Tool availability per phase';
    wrapper.querySelector('table')?.prepend(caption);
    setMeasuredWidths(wrapper, 600, 300);
    resizeWindow();

    expect(regionAttributes(wrapper)).toEqual({
      tabindex: '0',
      role: 'region',
      labelledby: null,
      label: 'Tool availability per phase',
    });
  });

  it('keeps an unnameable overflowing wrapper focusable but gives it no role', () => {
    const { container } = renderMarkdown(HEADLESS_TABLE_CONTENT);

    const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
    setMeasuredWidths(wrapper, 600, 300);
    resizeWindow();

    // An unnamed role="region" is not exposed as a landmark at all, so the
    // columns stay reachable and nothing false is announced.
    expect(regionAttributes(wrapper)).toEqual({
      tabindex: '0',
      role: null,
      labelledby: null,
      label: null,
    });
  });

  it('re-measures through a ResizeObserver where the environment has one', () => {
    const observed: Element[] = [];
    let notify = () => {};
    let disconnected = false;

    class TestResizeObserver {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {
        // Never called: the effect tears the whole observer down at once.
      }
      disconnect() {
        disconnected = true;
      }
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    try {
      const { container, unmount } = renderMarkdown(TABLE_CONTENT);

      const wrapper = container.querySelector<HTMLElement>('.table-scroll') as HTMLElement;
      // Both the container and the table it holds change width on their own.
      expect(observed).toEqual([wrapper, wrapper.querySelector('table')]);

      setMeasuredWidths(wrapper, 600, 300);
      notify();
      expect(wrapper.getAttribute('tabindex')).toBe('0');

      unmount();
      expect(disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A single-line fenced block: the copy control must reach the code's exact text.
const CODE_SNIPPET = 'npm install -g @alibaba-group/open-code-review';
const CODE_CONTENT = ['```bash', CODE_SNIPPET, '```'].join('\n');

// LanguageProvider resolves its language from this key on first render.
const LOCALE_STORAGE_KEY = 'ocr-lang';

// Drives a locale change from inside the provider, so the re-labelling of an
// already mounted copy control can be observed the way a user triggers it.
function LocaleSwitch({ to }: { to: Language }) {
  const { setLanguage } = useTranslation();
  return (
    <button type="button" onClick={() => setLanguage(to)}>
      switch locale
    </button>
  );
}

describe('MarkdownRenderer code copy control', () => {
  let writeText: ReturnType<typeof vi.fn>;

  // useCopyToast only takes the async clipboard path in a secure context, so
  // both halves of that condition are stubbed and the write is observable.
  const stubClipboard = () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  };

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    stubClipboard();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const renderMarkdown = (extra?: React.ReactNode) =>
    render(
      <LanguageProvider>
        {extra}
        <MarkdownRenderer content={CODE_CONTENT} />
      </LanguageProvider>,
    );

  const copyButton = (name: string) => screen.getByRole('button', { name });

  it('renders the copy control as a focusable button named by the locale', () => {
    renderMarkdown();

    const button = copyButton(en['docs.copyCode']);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('code-copy-btn');
    // A native button is in the tab order without a tabindex of its own.
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    // The icon must stay decorative or it would name the control "copy".
    expect(button.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it.each([
    ['ru', ru],
    ['ja', ja],
  ] as const)('names the copy control in the stored %s locale', (language, table) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, language);
    renderMarkdown();

    expect(copyButton(table['docs.copyCode']).getAttribute('aria-label')).toBe(table['docs.copyCode']);
    expect(screen.queryByRole('button', { name: en['docs.copyCode'] })).toBeNull();
  });

  it('re-labels the mounted copy control when the locale changes', () => {
    renderMarkdown(<LocaleSwitch to="ru" />);
    expect(copyButton(en['docs.copyCode'])).toBeTruthy();

    fireEvent.click(copyButton('switch locale'));

    expect(copyButton(ru['docs.copyCode']).getAttribute('aria-label')).toBe(ru['docs.copyCode']);
    expect(document.querySelectorAll('.code-copy-btn').length).toBe(1);
  });

  it('copies the code block text when the control is clicked', async () => {
    renderMarkdown();

    await act(async () => {
      fireEvent.click(copyButton(en['docs.copyCode']));
    });

    expect(writeText).toHaveBeenCalledWith(CODE_SNIPPET);
  });

  it('copies from the keyboard, with no keydown handler of its own', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub; restore the spy.
    stubClipboard();
    renderMarkdown();

    copyButton(en['docs.copyCode']).focus();
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledWith(CODE_SNIPPET);

    writeText.mockClear();
    await user.keyboard(' ');
    expect(writeText).toHaveBeenCalledWith(CODE_SNIPPET);
  });

  it('announces the copy in a polite status region that starts and ends empty', async () => {
    renderMarkdown();

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // Empty up front: a live region announces a content change, not text that
    // was already there when it mounted.
    expect(status.textContent).toBe('');

    await act(async () => {
      fireEvent.click(copyButton(en['docs.copyCode']));
    });
    expect(status.textContent).toBe(en['quickstart.copied']);

    // Cleared once the toast has faded, so a second copy announces again.
    await waitFor(() => expect(status.textContent).toBe(''), { timeout: 4000 });
  });
});
