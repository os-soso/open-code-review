// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { useState, useRef, useEffect, useId } from 'react';
import githubIcon from '../assets/icons/icon-github.svg';
import langIcon from '../assets/icons/icon-language.svg';
import { useTranslation } from '../i18n/context';
import { useResponsive } from '../hooks/useResponsive';
import type { Language } from '../i18n/types';

const LANG_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' }, // allow-non-english: language options are labelled in their own language
  { value: 'ja', label: '日本語' }, // allow-non-english: language options are labelled in their own language
  { value: 'ko', label: '한국어' }, // allow-non-english: language options are labelled in their own language
  { value: 'ru', label: 'Русский' }, // allow-non-english: language options are labelled in their own language
];

// Marks the selected language with a shape as well as a colour, so the current
// choice is not conveyed by colour alone.
const CheckIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
    <path d="M2.5 6.4L4.7 8.6L9.5 3.4" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Keyboard behaviour for the language menu: Escape dismisses it and hands
 * focus back to the trigger, Arrow keys move between the options with
 * wrap-around, and Home/End jump to the ends. Tab is left to the browser and
 * handled by closeOnFocusLeave, so the panel is still mounted when the browser
 * resolves the next focus target.
 *
 * The navbar carries its own copy of this pair: the two components share no
 * module, and adding one is out of scope for the fix these helpers land with.
 */
function handleMenuKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  target: { items: (HTMLElement | null)[]; close: () => void; restoreFocus: () => void },
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    target.close();
    target.restoreFocus();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
    return;
  }

  const items = target.items.filter((item): item is HTMLElement => item !== null);
  if (items.length === 0) return;
  event.preventDefault();

  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = items.length - 1;
  } else if (event.key === 'ArrowDown') {
    next = current < 0 ? 0 : (current + 1) % items.length;
  } else {
    next = current <= 0 ? items.length - 1 : current - 1;
  }
  items[next].focus();
}

/**
 * Dismisses the menu once focus has moved out of it, which covers Tab,
 * Shift+Tab and a click landing on another focusable control.
 */
function closeOnFocusLeave(event: React.FocusEvent<HTMLElement>, close: () => void): void {
  const next = event.relatedTarget as Node | null;
  if (!next || !event.currentTarget.contains(next)) close();
}

const Footer: React.FC = () => {
  const { language, setLanguage, t } = useTranslation();
  const { isMobile } = useResponsive();
  const [open, setOpen] = useState(false);
  // Hover and roving-keyboard feedback is held in state for the border, label
  // colour and highlight a selector cannot express: whether this control's
  // popup is open, and which option the arrow keys sit on. The focus ring is
  // not among them — it is authored in styles/index.css against
  // :focus-visible, because an inline `outline` would be the only ring these
  // controls could ever show and would vanish with the handler that set it.
  const [hoveredLang, setHoveredLang] = useState<Language | null>(null);
  const [focusedLang, setFocusedLang] = useState<Language | null>(null);
  const [triggerHover, setTriggerHover] = useState(false);
  const [triggerFocus, setTriggerFocus] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // One generated base per mounted footer keeps aria-controls unambiguous.
  const idBase = useId();
  const panelId = `${idBase}-language-menu`;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Opening the menu moves focus onto the option it reports as checked, which
  // is where the ARIA menu pattern expects a keyboard user to land.
  useEffect(() => {
    if (!open) return;
    const selected = LANG_OPTIONS.findIndex(opt => opt.value === language);
    optionRefs.current[selected < 0 ? 0 : selected]?.focus();
  }, [open, language]);

  const currentLabel = LANG_OPTIONS.find(o => o.value === language)?.label ?? 'English';
  return (
    <footer
      aria-label={t('footer.ariaLabel')}
      style={{
        width: '100%',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        padding: isMobile ? '32px 16px' : '64px 32px',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'flex-start' : 'center',
          gap: isMobile ? 16 : 0,
          maxWidth: 1440,
          margin: '0 auto',
        }}
      >
        {/* Vertical padding (never font-size) lifts the link's 21px box to a
          * 44px hit area; `.footer-link` brightens the label on hover and
          * press, which the inline colour used to make impossible. */}
        <a
          className="footer-link"
          href="https://github.com/alibaba/open-code-review"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '12px 0', textDecoration: 'none' }}
        >
          <img src={githubIcon} alt="" style={{ width: 18, height: 18 }} />
          <span className="footer-link-label" style={{ fontSize: 14 }}>{t('footer.brand')}</span>
        </a>
        {/* 0.6 alpha (the same level as footer.brand above) composites to
            rgb(153,153,153) on the black footer = 7.37:1; 0.4 was 3.65:1 and
            failed WCAG 1.4.3 AA for 13px text. */}
        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
          {t('footer.copyright')}
        </span>

        {/* Language Switcher */}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            type="button"
            ref={triggerRef}
            className="footer-lang-btn"
            onClick={() => setOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            /* Exposed only while the panel is mounted: an aria-controls naming
               an id that is absent from the document is an unresolvable
               reference, which an accessibility audit reports as invalid. */
            aria-controls={open ? panelId : undefined}
            aria-label={`${t('footer.languageLabel')}: ${currentLabel}`}
            onMouseEnter={() => setTriggerHover(true)}
            onMouseLeave={() => setTriggerHover(false)}
            onFocus={() => setTriggerFocus(true)}
            onBlur={() => setTriggerFocus(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              // No inline background and no inline outline: the resting, hover
              // and pressed fills and the :focus-visible ring are the
              // .footer-lang-btn rules in index.css, which an inline value
              // would shadow.
              // Hover, keyboard focus and the open state all brighten the
              // border and the label, which is the only interactive feedback
              // this control carries inline.
              minHeight: 44,
              border: open || triggerHover || triggerFocus
                ? '1px solid rgba(255,255,255,0.45)'
                : '1px solid rgba(255,255,255,0.17)',
              borderRadius: 6,
              padding: '10px 14px',
              color: open || triggerHover || triggerFocus ? '#FFFFFF' : 'rgba(255,255,255,0.6)',
              fontSize: 13,
              cursor: 'pointer',
              transition: 'border-color 0.2s, color 0.2s, background 0.15s',
            }}
          >
            <img src={langIcon} alt="" style={{ width: 14, height: 14 }} />
            {currentLabel}
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M1 1L5 5L9 1" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {open && (
            <div
              id={panelId}
              role="menu"
              aria-label={t('footer.languageLabel')}
              onKeyDown={e => handleMenuKeyDown(e, {
                items: optionRefs.current,
                close: () => setOpen(false),
                restoreFocus: () => triggerRef.current?.focus(),
              })}
              onBlur={e => closeOnFocusLeave(e, () => setOpen(false))}
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                marginBottom: 6,
                background: '#1a1a1a',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 8,
                padding: 4,
                zIndex: 10,
              }}
            >
              {LANG_OPTIONS.map((opt, index) => {
                const selected = opt.value === language;
                const highlighted = hoveredLang === opt.value || focusedLang === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className="lang-menu-item"
                    data-active={selected ? 'true' : undefined}
                    role="menuitemradio"
                    aria-checked={selected}
                    ref={el => { optionRefs.current[index] = el; }}
                    // The trigger is focused before the panel unmounts: the
                    // activated option is the focused element, so closing
                    // without this drops focus to the document.
                    onClick={() => { triggerRef.current?.focus(); setLanguage(opt.value); setOpen(false); }}
                    onMouseEnter={() => setHoveredLang(opt.value)}
                    onMouseLeave={() => setHoveredLang(prev => (prev === opt.value ? null : prev))}
                    onFocus={() => setFocusedLang(opt.value)}
                    onBlur={() => setFocusedLang(prev => (prev === opt.value ? null : prev))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      width: '100%',
                      minHeight: 44,
                      padding: '8px 12px',
                      // Hover, pressed and selected fills and the focus ring are
                      // the .lang-menu-item rules in index.css (keyed on
                      // data-active and :focus-visible); only the roving
                      // keyboard highlight, which no CSS state expresses, is
                      // painted inline — and only while it applies, so the
                      // stylesheet is never shadowed at rest.
                      background: focusedLang === opt.value ? 'rgba(255,255,255,0.16)' : undefined,
                      border: 'none',
                      borderRadius: 6,
                      color: selected || highlighted ? '#fff' : 'rgba(255,255,255,0.6)',
                      fontSize: 13,
                      fontWeight: selected ? 600 : 400,
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      transition: 'background 0.2s, color 0.2s',
                    }}
                  >
                    <span>{opt.label}</span>
                    <span style={{ display: 'flex', alignItems: 'center', width: 12, flexShrink: 0 }}>
                      {selected && <CheckIcon />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
};

export default Footer;
