import { useEffect, useId, useRef, useState } from 'react';
import Pagination from './Pagination.jsx';
import { usePagination } from '../lib/usePagination.js';

export function searchSelectOptions(items, query, filter, { allowCustomValue = false, customValueMaxLength } = {}) {
  const customValue = query.trim();
  const filtered = items.filter((item) => filter(item, customValue.toLowerCase()));
  const exactMatchIndex = filtered.findIndex((item) => item.id === customValue);
  if (exactMatchIndex > 0) {
    const [exactMatch] = filtered.splice(exactMatchIndex, 1);
    filtered.unshift(exactMatch);
  }
  const customItem =
    allowCustomValue &&
    customValue &&
    (!customValueMaxLength || customValue.length <= customValueMaxLength) &&
    !items.some((item) => item.id === customValue)
      ? { id: customValue, label: customValue, isCustomValue: true }
      : null;
  return customItem ? [customItem, ...filtered] : filtered;
}

export default function SearchSelect({
  items,
  value,
  onChange,
  placeholder,
  renderTrigger,
  renderItem,
  filter,
  openUp,
  height = 46,
  emptyText = 'No matches.',
  disabled = false,
  allowCustomValue = false,
  customValueLabel = 'Use exact value',
  customValueMaxLength,
  id,
  label,
  pageSize = 25,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef(null);
  const triggerRef = useRef(null);
  const listboxId = useId();
  const selected =
    items.find((item) => item.id === value) ||
    (allowCustomValue && value ? { id: value, label: value, isCustomValue: true } : undefined);
  const selectionDisabled = disabled || (items.length === 0 && !allowCustomValue);

  const options = searchSelectOptions(items, query, filter, { allowCustomValue, customValueMaxLength });
  const optionPages = usePagination(options, { pageSize, resetKey: query });
  const setOptionPage = optionPages.setPage;
  const activeOptionId = options[activeIndex] ? `${listboxId}-option-${activeIndex}` : null;

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => searchRef.current?.focus(), 10);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (selectionDisabled) setOpen(false);
  }, [selectionDisabled]);

  useEffect(() => {
    if (!open || options.length === 0) return;
    if (activeIndex < 0 || activeIndex >= options.length) {
      setActiveIndex(0);
      setOptionPage(1);
    }
  }, [activeIndex, open, options.length, setOptionPage]);

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId, open]);

  const openMenu = (direction = 1) => {
    if (selectionDisabled) return;
    const selectedIndex = options.findIndex((item) => item.id === value);
    const nextIndex = selectedIndex >= 0 ? selectedIndex : direction < 0 ? options.length - 1 : 0;
    setActiveIndex(nextIndex);
    optionPages.setPage(Math.floor(nextIndex / optionPages.pageSize) + 1);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const choose = (item) => {
    if (!item) return;
    onChange(item.id);
    closeMenu(true);
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = options.length ? (activeIndex + 1) % options.length : 0;
      setActiveIndex(nextIndex);
      optionPages.setPage(Math.floor(nextIndex / optionPages.pageSize) + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = options.length ? (activeIndex - 1 + options.length) % options.length : 0;
      setActiveIndex(nextIndex);
      optionPages.setPage(Math.floor(nextIndex / optionPages.pageSize) + 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={selectionDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' ? -1 : 1);
          }
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height,
          padding: '0 13px',
          border: '1px solid var(--border)',
          borderRadius: height >= 46 ? 9 : 8,
          background: 'var(--surface)',
          color: selectionDisabled ? 'var(--text-3)' : 'var(--text)',
          cursor: selectionDisabled ? 'not-allowed' : 'pointer',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        {renderTrigger(selected)}
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>▾</span>
      </button>
      {open && (
        <>
          <div aria-hidden="true" onClick={() => closeMenu()} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
          <div
            style={{
              position: 'absolute',
              [openUp ? 'bottom' : 'top']: height + 4,
              left: 0,
              right: 0,
              zIndex: 21,
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface)',
              boxShadow: '0 14px 36px rgba(0,0,0,.18)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: 8, borderBottom: '1px solid var(--border-2)' }}>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                  optionPages.setPage(1);
                }}
                onKeyDown={handleSearchKeyDown}
                role="combobox"
                aria-autocomplete="list"
                aria-label={`${label || 'Option'} search`}
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOptionId || undefined}
                spellCheck={false}
                maxLength={allowCustomValue ? customValueMaxLength : undefined}
                placeholder={placeholder}
                style={{
                  width: '100%',
                  height: 34,
                  padding: '0 11px',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  fontSize: 13,
                  outline: 'none',
                }}
              />
            </div>
            <div id={listboxId} role="listbox" style={{ maxHeight: 264, overflowY: 'auto', padding: 6 }}>
              {optionPages.pageItems.map((item, index) => {
                const globalIndex = optionPages.startIndex + index;
                if (item.isCustomValue) {
                  return (
                    <button
                      key={`custom-${item.id}`}
                      id={`${listboxId}-option-${globalIndex}`}
                      type="button"
                      role="option"
                      aria-selected={item.id === value}
                      tabIndex={-1}
                      onMouseMove={() => setActiveIndex(globalIndex)}
                      onClick={() => choose(item)}
                      style={{
                        width: '100%',
                        display: 'block',
                        padding: '10px 11px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        border: '1px dashed var(--border)',
                        color: 'var(--text)',
                        font: 'inherit',
                        textAlign: 'left',
                        background:
                          globalIndex === activeIndex || item.id === value ? 'var(--accent-subtle)' : 'transparent',
                      }}
                    >
                      <span style={{ display: 'block', color: 'var(--text-2)', fontSize: 11 }}>{customValueLabel}</span>
                      <span
                        className="mono"
                        style={{ display: 'block', marginTop: 2, fontSize: 12.5, fontWeight: 600 }}
                      >
                        {item.id}
                      </span>
                    </button>
                  );
                }
                return (
                  <button
                    key={item.id}
                    id={`${listboxId}-option-${globalIndex}`}
                    type="button"
                    role="option"
                    aria-selected={item.id === value}
                    tabIndex={-1}
                    onMouseMove={() => setActiveIndex(globalIndex)}
                    onClick={() => choose(item)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 11px',
                      borderRadius: 7,
                      cursor: 'pointer',
                      border: 'none',
                      color: 'var(--text)',
                      font: 'inherit',
                      textAlign: 'left',
                      background:
                        globalIndex === activeIndex || item.id === value ? 'var(--accent-subtle)' : 'transparent',
                    }}
                  >
                    {renderItem(item)}
                    {item.id === value && <span style={{ color: 'var(--accent)', fontSize: 13, flex: 'none' }}>✓</span>}
                  </button>
                );
              })}
              {options.length === 0 && (
                <div style={{ padding: 16, textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)' }}>
                  {emptyText}
                </div>
              )}
            </div>
            <Pagination
              {...optionPages}
              setPage={(nextPage) => {
                optionPages.setPage(nextPage);
                setActiveIndex((nextPage - 1) * optionPages.pageSize);
              }}
              itemLabel="options"
              compact
              style={{ marginTop: 0, padding: '8px', borderTop: '1px solid var(--border-2)' }}
            />
          </div>
        </>
      )}
    </div>
  );
}
