// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import searchIcon from '../assets/icons/icon-search.svg';

const fontFamily = 'PingFang SC, -apple-system, BlinkMacSystemFont, sans-serif';

interface SearchTriggerProps {
  placeholder: string;
  onClick: () => void;
  style?: React.CSSProperties;
}

export function SearchTrigger({ placeholder, onClick, style }: SearchTriggerProps) {
  return (
    <button
      /* `search-trigger` is the hook for the focus-visible ring and the pressed
       * state in styles/index.css. The inline `outline: none` this button used
       * to carry suppressed every indicator — including the UA ring — and an
       * inline declaration cannot be overridden from a stylesheet, so it is
       * gone rather than replaced. */
      className="search-trigger"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        minHeight: 44,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        cursor: 'pointer',
        // 0.6 alpha is the site's secondary-text level; over the composited
        // rgb(10,10,10) trigger background it reaches 7.30:1, clearing WCAG
        // 1.4.3 AA (4.5:1) which 0.4 (3.77:1) did not.
        color: 'rgba(255,255,255,0.6)',
        fontSize: 14,
        fontFamily,
        transition: 'border-color 0.15s',
        ...style,
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src={searchIcon} alt="" style={{ width: 16, height: 16, opacity: 0.6 }} />
        {placeholder}
      </span>
      {/* Same 0.6 alpha as the label: the shortcut hint was 2.60:1 at 0.3 and
          is 7.30:1 here, so the hint is legible rather than decorative. */}
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', lineHeight: 1 }}>
        {navigator.userAgent?.includes('Mac') ? '⌘K' : 'Ctrl+K'}
      </span>
    </button>
  );
}
