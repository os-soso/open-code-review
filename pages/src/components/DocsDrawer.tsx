// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Off-canvas navigation shell for the documentation page.
 *
 * The docs layout is a three-column shell: a 264px tree rail, the article, and
 * a 220px table-of-contents rail. Two fixed rails plus the article padding
 * cannot leave a readable column below 1024px, so the rails are progressively
 * turned into off-canvas panels reached from a fixed sub-toolbar:
 *
 * | Viewport        | Tree rail        | TOC rail         | Sub-toolbar toggles |
 * |-----------------|------------------|------------------|---------------------|
 * | < 768px         | off-canvas panel | off-canvas panel | tree + TOC          |
 * | 768px - 1024px  | mounted rail     | off-canvas panel | TOC                 |
 * | > 1024px        | mounted rail     | mounted rail     | none                |
 *
 * Both rails stay mounted in the DOM at every width - only their positioning
 * changes - so the docs tree, its search trigger and every TOC entry remain
 * reachable on a phone instead of being unmounted with no substitute.
 *
 * All styling is inline React style objects, matching the rest of pages/src
 * (there is no design system, no CSS modules and no utility-class framework in
 * these components). The green accents reuse the palette the active sidebar
 * row and the active TOC entry already paint with (#2BDE5E).
 */

/** Height of the fixed sub-toolbar that carries the panel toggles. */
export const DOCS_TOOLBAR_HEIGHT = 52;

/** The two panels the docs shell can turn into an off-canvas drawer. */
export type DocsDrawerPanelId = 'sidebar' | 'toc';

/** Imperative surface returned by {@link useDocsDrawer}. */
export interface DocsDrawerController {
  /** The panel currently open, or null when every panel is closed. */
  openPanel: DocsDrawerPanelId | null;
  /** Opens the given panel, or closes it when it is already the open one. */
  toggle: (panel: DocsDrawerPanelId) => void;
  /** Closes whichever panel is open. Safe to call when none is. */
  close: () => void;
  /**
   * Attach to the element that renders the OPEN panel. The hook focuses that
   * element when the panel opens and restores focus when it closes. Only one
   * panel is ever open, so a single ref is enough for both panels.
   */
  panelRef: React.RefCallback<HTMLElement>;
}

export interface UseDocsDrawerOptions {
  /**
   * False on desktop, where both rails are mounted and no panel exists. While
   * disabled the controller reports no open panel and installs no listeners.
   */
  enabled: boolean;
  /**
   * Any change closes the open panel. The docs page passes the breakpoint band,
   * the active doc slug and the command-palette flag, so navigating, crossing a
   * breakpoint or opening Ctrl+K all dismiss the drawer.
   */
  dismissKey: string;
}

/**
 * Reports whether the user asked for reduced motion.
 *
 * `window.matchMedia` is absent in jsdom (the unit-test environment) and can
 * throw on an unparsable query in older engines, so both are guarded: an
 * unknown preference degrades to "animation allowed", which is the behaviour of
 * every browser that does implement the query and does not match it.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Owns the open/closed state of the docs off-canvas panels together with the
 * three behaviours a modal-ish panel needs: Escape to dismiss, a body scroll
 * lock while open, and focus moved into the panel and handed back on close.
 *
 * Usage:
 *
 * ```tsx
 * const { openPanel, toggle, close, panelRef } = useDocsDrawer({
 *   enabled: !isDesktop,
 *   dismissKey: `${band}|${activeSlug}|${searchOpen}`,
 * });
 * ```
 */
export function useDocsDrawer({ enabled, dismissKey }: UseDocsDrawerOptions): DocsDrawerController {
  const [requestedPanel, setRequestedPanel] = useState<DocsDrawerPanelId | null>(null);
  /* Desktop has no panels at all, so the stored request is ignored rather than
   * rendered; keeping it in state would otherwise re-open a panel on resize. */
  const openPanel = enabled ? requestedPanel : null;
  const panelNodeRef = useRef<HTMLElement | null>(null);

  const panelRef = useCallback<React.RefCallback<HTMLElement>>((node) => {
    panelNodeRef.current = node;
  }, []);

  const toggle = useCallback(
    (panel: DocsDrawerPanelId) => {
      if (!enabled) return;
      setRequestedPanel((previous) => (previous === panel ? null : panel));
    },
    [enabled],
  );

  const close = useCallback(() => setRequestedPanel(null), []);

  /* A breakpoint change, a navigation or the command palette dismisses the
   * panel: it either no longer exists or would cover the new surface. */
  useEffect(() => {
    setRequestedPanel(null);
  }, [dismissKey]);

  /* Escape closes, matching the command palette's own dismissal. Registered on
   * the document because focus may sit on the backdrop or inside the panel. */
  useEffect(() => {
    if (!openPanel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRequestedPanel(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openPanel]);

  /* One effect covers the whole open/close transition, so the close path also
   * runs on unmount and when one panel replaces the other:
   *   - the previously focused element (the toggle that was activated) is
   *     remembered and focus is moved into the panel;
   *   - the body's inline overflow is saved and restored EXACTLY, never
   *     blanked: index.css sets overflow-x on body through a stylesheet, and an
   *     unconditional reset would drop any inline value another surface set. */
  useEffect(() => {
    if (!openPanel) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelNodeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (
        previouslyFocused &&
        typeof previouslyFocused.focus === 'function' &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [openPanel]);

  return { openPanel, toggle, close, panelRef };
}

/** Icon for a panel toggle: a hamburger for the tree, a list glyph for the TOC. */
const DocsDrawerToggleIcon: React.FC<{ panel: DocsDrawerPanelId; color: string }> = ({ panel, color }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
    {panel === 'sidebar' ? (
      <>
        <path d="M2 4H14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M2 8H14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M2 12H14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </>
    ) : (
      <>
        <circle cx="3" cy="4" r="1" fill={color} />
        <circle cx="3" cy="8" r="1" fill={color} />
        <circle cx="3" cy="12" r="1" fill={color} />
        <path d="M6.5 4H14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M6.5 8H14" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M6.5 12H11" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </>
    )}
  </svg>
);

/** One toggle in the sub-toolbar. */
export interface DocsDrawerToggleSpec {
  /** Panel this toggle opens. */
  panel: DocsDrawerPanelId;
  /** Visible text label, already translated. */
  label: string;
  /** DOM id of the panel element, exposed through aria-controls. */
  controls: string;
}

export interface DocsDrawerBarProps {
  /** Distance from the viewport top, i.e. the navbar height. */
  top: number;
  /** Toggles to render, in reading order. An empty list renders nothing. */
  toggles: DocsDrawerToggleSpec[];
  /** Panel currently open, so the matching toggle paints its active state. */
  openPanel: DocsDrawerPanelId | null;
  /** Invoked with the toggled panel id. */
  onToggle: (panel: DocsDrawerPanelId) => void;
  /** Font stack of the host page, so the labels match the surrounding chrome. */
  fontFamily: string;
}

const DocsDrawerToggleButton: React.FC<{
  spec: DocsDrawerToggleSpec;
  open: boolean;
  onToggle: (panel: DocsDrawerPanelId) => void;
  fontFamily: string;
}> = ({ spec, open, onToggle, fontFamily }) => {
  /* The repository authors no :hover or :focus-visible CSS for these controls
   * and index.css belongs to another surface, so both cues are component
   * state - the same pattern SearchTrigger uses for its border. */
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const highlighted = open || hovered || focused;
  const color = open ? '#2BDE5E' : highlighted ? '#ffffff' : 'rgba(255,255,255,0.8)';

  return (
    <button
      type="button"
      onClick={(event) => {
        /* Focus the toggle before opening: Safari does not focus a button on
         * tap, so without this the drawer would have no element to hand focus
         * back to when it closes. */
        event.currentTarget.focus();
        onToggle(spec.panel);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-expanded={open}
      aria-controls={spec.controls}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 40,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${open ? 'rgba(43,222,94,0.4)' : highlighted ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)'}`,
        background: open ? 'rgba(43,222,94,0.12)' : highlighted ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
        color,
        fontSize: 13,
        fontFamily,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        cursor: 'pointer',
        outline: focused ? '2px solid #2BDE5E' : 'none',
        outlineOffset: 2,
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
      }}
    >
      <DocsDrawerToggleIcon panel={spec.panel} color={color} />
      {spec.label}
    </button>
  );
};

/**
 * Fixed sub-toolbar directly below the navbar, carrying one toggle per panel
 * the caller turned into a drawer. It stays above the backdrop so the same
 * button that opened a panel can close it again.
 */
export const DocsDrawerBar: React.FC<DocsDrawerBarProps> = ({ top, toggles, openPanel, onToggle, fontFamily }) => {
  if (toggles.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        top,
        left: 0,
        right: 0,
        height: DOCS_TOOLBAR_HEIGHT,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderBottom: '1px solid rgba(61,61,61,0.6)',
      }}
    >
      {toggles.map((spec) => (
        <DocsDrawerToggleButton
          key={spec.panel}
          spec={spec}
          open={openPanel === spec.panel}
          onToggle={onToggle}
          fontFamily={fontFamily}
        />
      ))}
    </div>
  );
};

/**
 * Dimmed layer behind an open panel. It starts below the sub-toolbar so the
 * toggle row stays visible and clickable while a panel is open.
 */
export const DocsDrawerBackdrop: React.FC<{ top: number; onClose: () => void }> = ({ top, onClose }) => (
  <div
    onClick={onClose}
    style={{
      position: 'fixed',
      top,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.6)',
      zIndex: 94,
    }}
  />
);

/**
 * Complete style object for a rail rendered as an off-canvas panel.
 *
 * Returned wholesale rather than merged into the rail's own object: a sticky
 * rail and a fixed panel disagree on position, width, height and padding, and
 * a leftover rail property would place the panel in the flex flow and re-create
 * the squeezed column this shell exists to avoid.
 *
 * Closed panels keep their subtree in the DOM (so the docs tree and the TOC
 * entries are never missing) but are pushed off-canvas and made
 * `visibility: hidden`, which also removes their controls from the tab order.
 */
export function docsDrawerPanelStyle(side: 'left' | 'right', top: number, open: boolean): React.CSSProperties {
  const fromLeft = side === 'left';
  const edge: React.CSSProperties = fromLeft
    ? { left: 0, borderRight: '1px solid rgba(255,255,255,0.12)' }
    : { right: 0, borderLeft: '1px solid rgba(255,255,255,0.12)' };
  const hiddenTransform = fromLeft ? 'translateX(-100%)' : 'translateX(100%)';
  return {
    position: 'fixed',
    top,
    bottom: 0,
    ...edge,
    width: 'min(320px, 88vw)',
    background: '#0a0a0a',
    overflowY: 'auto',
    padding: '24px 20px 40px',
    zIndex: 96,
    outline: 'none',
    boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
    transform: open ? 'translateX(0)' : hiddenTransform,
    visibility: open ? 'visible' : 'hidden',
    pointerEvents: open ? 'auto' : 'none',
    transition: prefersReducedMotion() ? undefined : 'transform 0.2s ease',
  };
}
