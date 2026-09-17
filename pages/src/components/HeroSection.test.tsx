// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../i18n';
import HeroSection from './HeroSection';

// The shader background is stubbed because the real component pulls three.js in,
// and what these tests are about is whether the hero mounts it at all. The one
// test that exercises the component itself imports the real module explicitly.
vi.mock('./ColorBends', () => ({
  default: (props: { style?: React.CSSProperties }) =>
    React.createElement('div', { 'data-testid': 'color-bends', style: props.style }),
}));

// jsdom implements no canvas at all, so both branches of the hero's WebGL probe
// have to be driven by stubbing that one boundary. The default is a browser
// without WebGL — the environment the missing guard was found in.
function stubWebGL(available: boolean): void {
  const context = { getExtension: () => null };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    available && (kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl')
      ? context
      : null) as unknown as HTMLCanvasElement['getContext']);
}

// The hero waits two animation frames before it loads the shader chunk, so both
// have to pass — plus a microtask turn for the lazy import — before the absence
// of the background means anything.
async function settleShaderFrames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

// The fallback backdrop is the only element carrying the radial gradient inline,
// so it is found the way a reader of the rendered DOM would find it.
const gradientBackdrop = () => document.querySelector('div[style*="radial-gradient"]');

beforeEach(() => {
  stubWebGL(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderHero() {
  render(
    <MemoryRouter>
      <LanguageProvider>
        <HeroSection />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

// The panel is found through the id that `aria-controls` already points at, so
// the test leans on the accessibility wiring instead of a test-only hook.
const panel = () => document.getElementById('install-more-panel');
const trigger = () => screen.getByRole('button', { name: /More|MacPorts/i });

describe('HeroSection install channels', () => {
  it('starts on the first channel with the panel closed', () => {
    renderHero();
    expect(screen.getByText('npm i -g @alibaba-group/open-code-review')).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('picking an overflow channel swaps the command and closes the panel', async () => {
    const user = userEvent.setup();
    renderHero();

    await user.click(trigger());
    expect(panel()).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /MacPorts/i }));

    expect(screen.getByText('sudo port install open-code-review')).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('closes when a primary tab is clicked', async () => {
    const user = userEvent.setup();
    renderHero();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: /Homebrew/i }));

    expect(screen.getByText('brew install open-code-review')).toBeTruthy();
    expect(panel()).toBeNull();
  });

  // Keyboard activation dispatches `click` with no preceding `mousedown`, so
  // this does not go through the same path as the test above.
  it('closes when a primary tab is activated by keyboard', async () => {
    const user = userEvent.setup();
    renderHero();

    await user.click(trigger());
    screen.getByRole('button', { name: /Homebrew/i }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('brew install open-code-review')).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('closes on Escape and on an outside click', async () => {
    const user = userEvent.setup();
    renderHero();

    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();

    await user.click(trigger());
    await user.click(document.body);
    expect(panel()).toBeNull();
  });

  it('reflects the selected overflow channel on the trigger', async () => {
    const user = userEvent.setup();
    renderHero();
    expect(screen.getByRole('button', { name: /^More$/i })).toBeTruthy();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: /MacPorts/i }));

    const collapsed = screen.getByRole('button', { name: /MacPorts/i });
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^More$/i })).toBeNull();
  });
});

describe('HeroSection shader background', () => {
  it('keeps the gradient and never mounts the shader where WebGL is unavailable', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHero();

    await settleShaderFrames();

    expect(screen.queryByTestId('color-bends')).toBeNull();
    expect(gradientBackdrop()).not.toBeNull();
    // three.js writes its own console errors and then throws when it cannot get
    // a context, and the ErrorBoundary reports that throw as well — so a silent
    // console is what proves the renderer was never asked for.
    expect(errors.mock.calls).toEqual([]);
  });

  it('mounts the shader background where WebGL is available', async () => {
    stubWebGL(true);
    renderHero();

    await settleShaderFrames();

    await waitFor(() => expect(screen.getByTestId('color-bends')).toBeTruthy());
  });

  // The component is guarded independently of the hero: mounted on its own
  // without WebGL it must add no canvas and say nothing.
  it('the shader component itself stays empty and silent where WebGL is unavailable', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: ColorBends } = await vi.importActual<typeof import('./ColorBends')>('./ColorBends');

    const { container } = render(<ColorBends colors={['#0d750d', '#042e04', '#066020']} />);
    await settleShaderFrames();

    expect(container.querySelector('canvas')).toBeNull();
    expect(errors.mock.calls).toEqual([]);
  });
});
