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
    expect(headingCode?.className).toBe('docs-heading-code');
    // Body code keeps the stylesheet's own sizing.
    const bodyCode = container.querySelector('p code');
    expect(bodyCode?.getAttribute('style')).toBeNull();
    expect(bodyCode?.className).toBe('');
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
