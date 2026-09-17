// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import { useState, useEffect } from 'react';

/**
 * The three viewport bands every responsive component in pages/src branches on.
 *
 * | Flag        | Viewport width   |
 * |-------------|------------------|
 * | isMobile    | < 768px          |
 * | isTablet    | 768px - 1024px   |
 * | isDesktop   | > 1024px         |
 */
export interface Breakpoints {
  isMobile: boolean;   // < 768px
  isTablet: boolean;   // 768px ~ 1024px
  isDesktop: boolean;  // > 1024px
}

/**
 * Tracks the current viewport band, re-reading it on every window resize.
 *
 * How the documentation shell consumes these flags (DocsPage.tsx): the left
 * docs-tree rail mounts from `!isMobile`, but the right table-of-contents rail
 * mounts only on `isDesktop`. The two rails are fixed-width - 264px and 220px -
 * and the article adds 96px of horizontal padding, so mounting both at 768px
 * would leave a 188px prose column, narrower than the 335px the same text gets
 * on a 375px phone. Below each of those thresholds the corresponding rail
 * becomes an off-canvas panel instead of unmounting, so the docs tree, its
 * search trigger and the TOC entries stay reachable at every width.
 */
export function useResponsive(): Breakpoints {
  const [bp, setBp] = useState<Breakpoints>(() => getBreakpoints());

  useEffect(() => {
    const handleResize = () => setBp(getBreakpoints());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return bp;
}

function getBreakpoints(): Breakpoints {
  const w = window.innerWidth;
  return {
    isMobile: w < 768,
    isTablet: w >= 768 && w <= 1024,
    isDesktop: w > 1024,
  };
}
