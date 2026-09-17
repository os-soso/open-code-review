// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React, { useState, useRef, useEffect, useId } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useResponsive } from '../hooks/useResponsive';
import socialIcon from '../assets/icons/icon-github.svg';
import brandIcon from '../assets/images/brandicon.svg';

import type { Language } from '../i18n/types';

const LANG_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' }, // allow-non-english: language options are labelled in their own language
  { value: 'ja', label: '日本語' }, // allow-non-english: language options are labelled in their own language
  { value: 'ko', label: '한국어' }, // allow-non-english: language options are labelled in their own language
  { value: 'ru', label: 'Русский' }, // allow-non-english: language options are labelled in their own language
];

const LANG_BADGE: Record<Language, string> = {
  en: 'En',
  zh: '中', // allow-non-english: single-glyph locale badge
  ja: 'あ', // allow-non-english: single-glyph locale badge
  ko: '한', // allow-non-english: single-glyph locale badge
  ru: 'Ru',
};

// Locales whose badge glyph needs a script-specific face; everything else uses
// the default stack below.
const LANG_BADGE_FONT: Partial<Record<Language, string>> = {
  ja: "'Hiragino Sans', sans-serif",
  ko: "'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif",
};

const DEFAULT_LANG_BADGE_FONT = "'PingFang SC', -apple-system, sans-serif";

const navTabs = [
  { path: '/features', labelKey: 'navbar.features' },
  { path: '/benchmark', labelKey: 'navbar.benchmark' },
  { path: '/quickstart', labelKey: 'navbar.quickstart' },
  { path: '/docs', labelKey: 'navbar.docs' },
  { path: '/blog', labelKey: 'navbar.blog' },
];

// The GitHub link and the "Get Started" call to action move into the collapsed
// menu on phones, where the inline row has no space left for them. Their keys
// identify them in the roving-focus order and in the hover/focus state.
const MENU_KEY_GITHUB = 'github';
const MENU_KEY_CTA = 'cta';

const GITHUB_URL = 'https://github.com/alibaba/open-code-review';

// Marker put on the history entry of a navigation started from the collapsed
// menu, so that whichever navbar renders for the destination can finish the
// focus hand-off.
//
// It travels on the navigation rather than in a ref because the navbar does not
// reliably survive the navigation it triggers: every page component renders its
// own <Navbar />, so moving between two different page components unmounts this
// instance and mounts a fresh one. Component-local state goes with it, while the
// history entry reaches the replacement.
interface NavMenuLocationState {
  focusNavMenuTrigger?: boolean;
}

// Focus ring colour, applied inline: the navbar is styled with inline style
// objects only, so no :focus-visible rule can reach these controls.
const FOCUS_RING = '2px solid #2BDE5E';

// Hamburger / close icon, drawn rather than typed: a glyph character would be
// locale-dependent and would not survive the repository's English-only check.
const MenuIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
    {expanded ? (
      <>
        <path d="M4 4L14 14" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M14 4L4 14" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ) : (
      <>
        <path d="M2.5 4.5H15.5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M2.5 9H15.5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M2.5 13.5H15.5" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
      </>
    )}
  </svg>
);

// Marks the selected language in the switcher with a shape as well as a
// colour, so the current choice is not conveyed by colour alone.
const CheckIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
    <path d="M2.5 6.4L4.7 8.6L9.5 3.4" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface MenuKeyboardTarget {
  /** The menu's items in DOM order; nulls (unmounted rows) are skipped. */
  items: (HTMLElement | null)[];
  /** Dismisses the menu. */
  close: () => void;
  /** Returns focus to the control that opened the menu. */
  restoreFocus: () => void;
}

/**
 * Keyboard behaviour shared by the two ARIA menus in this navbar: Escape
 * dismisses and hands focus back to the trigger, Arrow keys move between the
 * items with wrap-around, and Home/End jump to the ends. Tab is deliberately
 * left to the browser and handled by closeOnFocusLeave below, so the panel is
 * still mounted when the browser picks the next control to focus.
 *
 * Example: `onKeyDown={e => handleMenuKeyDown(e, { items, close, restoreFocus })}`
 * on the element carrying `role="menu"`.
 */
function handleMenuKeyDown(event: React.KeyboardEvent<HTMLElement>, target: MenuKeyboardTarget): void {
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
 * Dismisses a popup once focus has moved out of it, which covers Tab,
 * Shift+Tab and a click that lands on another focusable control. Keeping this
 * out of the keydown handler matters: the panel has to still be mounted when
 * the browser resolves Tab, or focus would fall back to the document body.
 */
function closeOnFocusLeave(event: React.FocusEvent<HTMLElement>, close: () => void): void {
  const next = event.relatedTarget as Node | null;
  if (!next || !event.currentTarget.contains(next)) close();
}

const Navbar: React.FC = () => {
  const { language, setLanguage, t } = useTranslation();
  const { isMobile, isDesktop } = useResponsive();
  const location = useLocation();
  const navigate = useNavigate();
  const [langOpen, setLangOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Hover and keyboard-focus feedback is held in state because every style
  // here is an inline style object: there is no stylesheet for this component
  // to carry :hover / :focus-visible rules.
  const [hoveredLang, setHoveredLang] = useState<Language | null>(null);
  const [focusedLang, setFocusedLang] = useState<Language | null>(null);
  const [langTriggerFocus, setLangTriggerFocus] = useState(false);
  const [menuTriggerHover, setMenuTriggerHover] = useState(false);
  const [menuTriggerFocus, setMenuTriggerFocus] = useState(false);
  const [hoveredMenuKey, setHoveredMenuKey] = useState<string | null>(null);
  const [focusedMenuKey, setFocusedMenuKey] = useState<string | null>(null);

  const langRef = useRef<HTMLDivElement>(null);
  const langTriggerRef = useRef<HTMLButtonElement>(null);
  const langOptionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // The collapsed menu's rows in DOM order; React clears an entry to null
  // when a row unmounts, which is why the keyboard helper filters nulls.
  const menuItemRefs = useRef<(HTMLElement | null)[]>([]);

  // One generated base per mounted navbar keeps aria-controls unambiguous even
  // if a route ever renders the component twice.
  const idBase = useId();
  const langPanelId = `${idBase}-language-menu`;
  const menuPanelId = `${idBase}-primary-menu`;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Opening the language menu moves focus onto the option it reports as
  // checked, which is where the ARIA menu pattern expects a keyboard user to
  // land.
  useEffect(() => {
    if (!langOpen) return;
    const selected = LANG_OPTIONS.findIndex(opt => opt.value === language);
    langOptionRefs.current[selected < 0 ? 0 : selected]?.focus();
  }, [langOpen, language]);

  // Opening the collapsed navigation menu moves focus to its first item.
  useEffect(() => {
    if (!menuOpen) return;
    menuItemRefs.current.find((item): item is HTMLElement => item !== null)?.focus();
  }, [menuOpen]);

  // A destination chosen from either panel, or a browser Back, must not leave
  // the panel hanging open over the new page.
  useEffect(() => {
    setMenuOpen(false);
    setLangOpen(false);
  }, [location.pathname]);

  // Completes the focus hand-off started in goTo(), for the case where this
  // navbar is a fresh instance rather than the one the user clicked in: the
  // click focused a hamburger that no longer exists, so focus sits on <body>
  // and is picked up here. Where the original instance did survive, its own
  // focus() already landed and the guard leaves that focus alone.
  useEffect(() => {
    const state = location.state as NavMenuLocationState | null;
    if (!state?.focusNavMenuTrigger) return;
    if (document.activeElement !== document.body) return;
    menuTriggerRef.current?.focus();
  }, [location]);

  // Above the tablet band the hamburger is unmounted, so drop its state with
  // it: resizing back down must not reveal a panel the user never opened.
  useEffect(() => {
    if (isDesktop) setMenuOpen(false);
  }, [isDesktop]);

  const currentPath = location.pathname;

  // The active-tab rule, shared by the inline tabs and the collapsed menu:
  // "/features" also owns the landing route, every other tab owns its prefix.
  const isTabActive = (tabPath: string): boolean =>
    tabPath === '/features'
      ? (currentPath === '/' || currentPath.startsWith('/features'))
      : currentPath.startsWith(tabPath);

  const currentLangLabel = LANG_OPTIONS.find(opt => opt.value === language)?.label ?? 'English';

  const openLangMenu = (open: boolean) => {
    setLangOpen(open);
    if (open) setMenuOpen(false);
  };

  const openNavMenu = (open: boolean) => {
    setMenuOpen(open);
    if (open) setLangOpen(false);
  };

  // Activating a row unmounts the panel that row lives in, so focus is handed
  // back to the hamburger — dropping it to <body> would strand a keyboard user
  // at the top of a freshly rendered page with no position to tab from. The
  // immediate focus() covers the case where this navbar survives the
  // navigation; the marker on the history entry covers the case where it is
  // replaced, and is consumed by the effect above on whichever instance renders
  // for the destination.
  const goTo = (path: string) => {
    menuTriggerRef.current?.focus();
    setMenuOpen(false);
    const state: NavMenuLocationState = { focusNavMenuTrigger: true };
    navigate(path, { state });
  };

  // The GitHub row opens in a new tab rather than navigating, so it only closes
  // the panel — but it unmounts with it and needs the same focus hand-back.
  const closeNavMenuWithFocus = () => {
    menuTriggerRef.current?.focus();
    setMenuOpen(false);
  };

  // A collapsed-menu row: transparent by default, lifted while hovered or
  // focused, and tinted plus emboldened when it is the current page.
  const menuRowStyle = (key: string, active: boolean): React.CSSProperties => {
    const highlighted = hoveredMenuKey === key || focusedMenuKey === key;
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '10px 14px',
      background: highlighted
        ? 'rgba(255,255,255,0.16)'
        : active ? 'rgba(255,255,255,0.08)' : 'transparent',
      border: 'none',
      borderRadius: 6,
      color: '#FFFFFF',
      opacity: active || highlighted ? 1 : 0.75,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: active ? 500 : 400,
      textAlign: 'left' as const,
      whiteSpace: 'nowrap' as const,
      textDecoration: 'none',
      cursor: 'pointer',
      outline: focusedMenuKey === key ? FOCUS_RING : 'none',
      outlineOffset: -2,
      transition: 'background 0.2s, opacity 0.2s',
    };
  };

  const menuRowHandlers = (key: string) => ({
    onMouseEnter: () => setHoveredMenuKey(key),
    onMouseLeave: () => setHoveredMenuKey(prev => (prev === key ? null : prev)),
    onFocus: () => setFocusedMenuKey(key),
    onBlur: () => setFocusedMenuKey(prev => (prev === key ? null : prev)),
  });

  return (
    <nav
      aria-label={t('navbar.ariaLabel')}
      style={{
        width: '100%',
        height: isMobile ? 56 : 72,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        borderBottom: '1px solid rgba(61,61,61,0.6)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 100,
        willChange: 'transform',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1440,
          height: isMobile ? 56 : 72,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: isMobile ? '0 16px' : '0 32px',
        }}
      >
        {/* Logo. minHeight gives the clickable area a 44px hit target at every
          * viewport: the mark itself is only 20px tall on mobile and 24px on
          * desktop, so the target used to fall below the 24x24 floor of WCAG
          * 2.5.8 whenever the mobile logo was rendered. Height only — the width
          * is already well past 44 and must keep shrinking with the nav row. */}
        <div
          style={{ display: 'flex', alignItems: 'center', minHeight: 44, cursor: 'pointer' }}
          onClick={() => navigate('/')}
        >
          <img src={brandIcon} alt="Open Code Review" style={{ height: isMobile ? 20 : 24 }} />
        </div>

        {/* Nav Tabs - inline only in the desktop band; below it they collapse
            into the menu rendered next to the language switcher, because five
            labels in ja or ru do not fit a tablet row without breaking. */}
        {isDesktop && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {navTabs.map((tab) => {
              const isActive = isTabActive(tab.path);
              return (
                /* `.nav-tab` owns the background and the label opacity: both
                 * have to change on :hover / :active, and an inline value
                 * would win over the stylesheet and freeze them (which is
                 * exactly why the declared background transition never ran).
                 * data-active carries the selected tab's look. */
                <button
                  key={tab.path}
                  type="button"
                  className="nav-tab"
                  data-active={isActive ? 'true' : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => navigate(tab.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    minHeight: 44,
                    padding: '8px 16px',
                    borderRadius: 8,
                    border: 'none',
                    cursor: 'pointer',
                    transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <span
                    className="nav-tab-label"
                    style={{
                      color: '#FFFFFF',
                      fontSize: 14,
                      lineHeight: '20px',
                      fontWeight: isActive ? 500 : 400,
                      whiteSpace: 'nowrap',
                      transition: 'opacity 0.2s',
                    }}
                  >
                    {t(tab.labelKey)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Right section */}
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 16 }}>
          {/* Collapsed navigation menu - replaces the inline tabs below the
              desktop band, and on phones also hosts the GitHub link and the
              call to action, which no longer fit the row beside the logo. */}
          {!isDesktop && (
            <div ref={menuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                ref={menuTriggerRef}
                onClick={() => openNavMenu(!menuOpen)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                // Only while the panel is mounted: an aria-controls pointing at
                // an id that is not in the document is an unresolvable
                // reference, which an accessibility audit reports as invalid.
                aria-controls={menuOpen ? menuPanelId : undefined}
                aria-label={t('navbar.menuLabel')}
                onMouseEnter={() => setMenuTriggerHover(true)}
                onMouseLeave={() => setMenuTriggerHover(false)}
                onFocus={() => setMenuTriggerFocus(true)}
                onBlur={() => setMenuTriggerFocus(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  padding: 0,
                  background: menuOpen || menuTriggerHover || menuTriggerFocus
                    ? 'rgba(255,255,255,0.12)'
                    : 'transparent',
                  border: '1px solid rgba(255,255,255,0.24)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  flexShrink: 0,
                  boxSizing: 'border-box' as const,
                  outline: menuTriggerFocus ? FOCUS_RING : 'none',
                  outlineOffset: 2,
                  transition: 'background 0.2s',
                }}
              >
                <MenuIcon expanded={menuOpen} />
              </button>
              {menuOpen && (
                <div
                  id={menuPanelId}
                  role="menu"
                  aria-label={t('navbar.menuLabel')}
                  onKeyDown={e => handleMenuKeyDown(e, {
                    items: menuItemRefs.current,
                    close: () => setMenuOpen(false),
                    restoreFocus: () => menuTriggerRef.current?.focus(),
                  })}
                  onBlur={e => closeOnFocusLeave(e, () => setMenuOpen(false))}
                  style={isMobile
                    ? {
                        // Full-width sheet on phones: a narrow anchored card
                        // cannot hold the ja and ru labels on one line.
                        position: 'fixed',
                        left: 0,
                        right: 0,
                        top: 56,
                        maxHeight: 'calc(100vh - 56px)',
                        overflowY: 'auto',
                        background: '#1a1a1a',
                        borderTop: '1px solid rgba(255,255,255,0.15)',
                        borderBottom: '1px solid rgba(255,255,255,0.15)',
                        padding: 8,
                        zIndex: 200,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }
                    : {
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: 8,
                        background: '#1a1a1a',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 8,
                        padding: 4,
                        zIndex: 200,
                        minWidth: 180,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                >
                  {navTabs.map((tab, index) => {
                    const isActive = isTabActive(tab.path);
                    return (
                      <button
                        key={tab.path}
                        type="button"
                        role="menuitem"
                        ref={el => { menuItemRefs.current[index] = el; }}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => goTo(tab.path)}
                        {...menuRowHandlers(tab.path)}
                        style={menuRowStyle(tab.path, isActive)}
                      >
                        {t(tab.labelKey)}
                      </button>
                    );
                  })}
                  {isMobile && (
                    <>
                      <div
                        role="separator"
                        style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '4px 6px' }}
                      />
                      <a
                        role="menuitem"
                        ref={el => { menuItemRefs.current[navTabs.length] = el; }}
                        href={GITHUB_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={closeNavMenuWithFocus}
                        {...menuRowHandlers(MENU_KEY_GITHUB)}
                        style={menuRowStyle(MENU_KEY_GITHUB, false)}
                      >
                        <img src={socialIcon} alt="" style={{ width: 18, height: 18 }} />
                        GitHub
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        ref={el => { menuItemRefs.current[navTabs.length + 1] = el; }}
                        onClick={() => goTo('/quickstart')}
                        {...menuRowHandlers(MENU_KEY_CTA)}
                        style={{
                          width: '100%',
                          height: 40,
                          marginTop: 4,
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          padding: '4px 12px',
                          background: '#ffffff',
                          border: '1px solid #EBEBEB',
                          borderRadius: 6,
                          color: 'rgba(0,0,0,0.77)',
                          fontSize: 14,
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          cursor: 'pointer',
                          opacity: hoveredMenuKey === MENU_KEY_CTA ? 0.88 : 1,
                          outline: focusedMenuKey === MENU_KEY_CTA ? FOCUS_RING : 'none',
                          outlineOffset: 2,
                        }}
                      >
                        {t('navbar.getStarted')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Language Switcher */}
          <div ref={langRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            {/* The button is a 44x44 hit area (WCAG 2.5.5); the badge people
              * actually see is the 18x18 bordered box inside it, so the
              * control grew without the visual design changing. Opacity and
              * the hover fill live in `.nav-icon-btn`. */}
            <button
              type="button"
              className="nav-icon-btn"
              ref={langTriggerRef}
              onClick={() => openLangMenu(!langOpen)}
              aria-haspopup="menu"
              aria-expanded={langOpen}
              /* See the menu trigger above: the reference is exposed only while
                 the panel it names is actually in the document. */
              aria-controls={langOpen ? langPanelId : undefined}
              aria-label={`${t('navbar.languageLabel')}: ${currentLangLabel}`}
              onFocus={() => setLangTriggerFocus(true)}
              onBlur={() => setLangTriggerFocus(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                cursor: 'pointer',
                // The resting dim and the hover fill are the .nav-icon-btn
                // rules in index.css; the badge is only forced to full strength
                // inline while the menu is open or the trigger holds keyboard
                // focus, states the stylesheet cannot see, so the class rules
                // are never shadowed at rest.
                opacity: langOpen || langTriggerFocus ? 1 : undefined,
                outline: langTriggerFocus ? FOCUS_RING : 'none',
                outlineOffset: 2,
                padding: 0,
                width: 44,
                height: 44,
                boxSizing: 'border-box' as const,
              }}
            >
              <span style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #FFFFFF',
                borderRadius: 4,
                width: 18,
                height: 18,
                boxSizing: 'border-box' as const,
              }}>
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#FFFFFF',
                  lineHeight: '18px',
                  textAlign: 'center' as const,
                  width: '100%',
                  fontFamily: LANG_BADGE_FONT[language] ?? DEFAULT_LANG_BADGE_FONT,
                }}>
                  {LANG_BADGE[language]}
                </span>
              </span>
            </button>
            {langOpen && (
              <div
                id={langPanelId}
                role="menu"
                aria-label={t('navbar.languageLabel')}
                onKeyDown={e => handleMenuKeyDown(e, {
                  items: langOptionRefs.current,
                  close: () => setLangOpen(false),
                  restoreFocus: () => langTriggerRef.current?.focus(),
                })}
                onBlur={e => closeOnFocusLeave(e, () => setLangOpen(false))}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 8,
                  background: '#1a1a1a',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 8,
                  padding: 4,
                  zIndex: 200,
                  minWidth: 100,
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
                      ref={el => { langOptionRefs.current[index] = el; }}
                      // The trigger is focused before the panel unmounts:
                      // the activated option is the focused element, so
                      // closing without this drops focus to the document.
                      onClick={() => { langTriggerRef.current?.focus(); setLanguage(opt.value); setLangOpen(false); }}
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
                        // Hover, pressed and selected fills are the .lang-menu-item
                        // rules in index.css (keyed on data-active); only the
                        // roving keyboard highlight, which no CSS state
                        // expresses, is painted inline — and only while it
                        // applies, so the stylesheet is never shadowed at rest.
                        background: focusedLang === opt.value ? 'rgba(255,255,255,0.16)' : undefined,
                        border: 'none',
                        borderRadius: 6,
                        color: selected || highlighted ? '#fff' : 'rgba(255,255,255,0.6)',
                        fontSize: 13,
                        fontWeight: selected ? 600 : 400,
                        textAlign: 'left' as const,
                        whiteSpace: 'nowrap' as const,
                        cursor: 'pointer',
                        outline: focusedLang === opt.value ? FOCUS_RING : 'none',
                        outlineOffset: -2,
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
          {/* The GitHub link and the call to action stay inline from the
              tablet band upwards. On phones the 160px brand asset, the badge
              and a 32px menu trigger already consume the row, so both live in
              the menu panel above instead. */}
          {/* 44x44 hit area around the unchanged 22x22 mark; opacity and the
            * hover fill come from `.nav-icon-btn`. */}
          {!isMobile && (
            <a
              className="nav-icon-btn"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44 }}
            >
              <img src={socialIcon} alt="Social" style={{ width: 22, height: 22 }} />
            </a>
          )}
          {/* `.nav-cta` owns the white fill so the pill can dim on hover and
            * press; the border, radius and type scale are unchanged and the
            * pill is 44 tall instead of 32. */}
          {!isMobile && (
            <button
              type="button"
              className="nav-cta"
              onClick={() => navigate('/quickstart')}
              style={{
                minHeight: 44,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                border: '1px solid #EBEBEB',
                borderRadius: 6,
                color: 'rgba(0,0,0,0.77)',
                fontSize: 14,
                fontWeight: 500,
                // Locale labels such as the ja and ru wording are longer than
                // the en one: without these two the pill kept its fixed height,
                // wrapped the label to three lines and showed one glyph.
                whiteSpace: 'nowrap',
                flexShrink: 0,
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
            >
              {t('navbar.getStarted')}
            </button>
          )}
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
