// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasWebGLSupport } from './webgl';

// jsdom implements no canvas at all, so every case below drives the one boundary
// the probe depends on: HTMLCanvasElement.prototype.getContext.
function stubGetContext(impl: (kind: string) => unknown): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    impl as unknown as HTMLCanvasElement['getContext'],
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasWebGLSupport', () => {
  it('reports no support when no context type is available', () => {
    stubGetContext(() => null);
    expect(hasWebGLSupport()).toBe(false);
  });

  it('reports support from a WebGL 2 context and releases it again', () => {
    const loseContext = vi.fn();
    const kinds: string[] = [];
    stubGetContext((kind) => {
      kinds.push(kind);
      return kind === 'webgl2' ? { getExtension: () => ({ loseContext }) } : null;
    });

    expect(hasWebGLSupport()).toBe(true);
    // Asked for the newest context first, and stopped there.
    expect(kinds).toEqual(['webgl2']);
    // The probe must not keep one of the document's few contexts alive.
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('falls back to WebGL 1 when WebGL 2 is unavailable', () => {
    const kinds: string[] = [];
    stubGetContext((kind) => {
      kinds.push(kind);
      return kind === 'webgl' ? { getExtension: () => null } : null;
    });

    expect(hasWebGLSupport()).toBe(true);
    expect(kinds).toEqual(['webgl2', 'webgl']);
  });

  it('reports no support when getContext throws', () => {
    stubGetContext(() => {
      throw new Error('WebGL is blocked');
    });
    expect(hasWebGLSupport()).toBe(false);
  });
});
