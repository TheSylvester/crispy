/**
 * SessionSelector — root session list component with filtering and grouping
 *
 * Owns local UI state (search query, vendor filter, focus index, showAll)
 * and orchestrates the 5-stage filtering pipeline:
 *   1. Project filter → 2. Vendor filter → 3. Search filter
 *   → 4. Time grouping → 5. Render cap
 *
 * Reads shared state from SessionContext and PreferencesContext. Selection
 * triggers sidebar auto-collapse after 200ms (existing behavior preserved).
 *
 * Does NOT interact with the transport layer directly — all session data
 * flows through SessionContext.
 *
 * @module SessionSelector
 */

import { useState, useMemo, useDeferredValue, useCallback, useRef, useEffect } from 'react';
import { useSession } from '../../context/SessionContext.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { useSessionStatus } from '../../hooks/useSessionStatus.js';
import { useAvailableCwds } from '../../hooks/useAvailableCwds.js';
import { useSessionGrouping } from '../../hooks/useSessionGrouping.js';
import { useKeyboardNavigation } from '../../hooks/useKeyboardNavigation.js';
import { fsPathToUrlPath } from '../../../core/url-path-resolver.js';
import type { WireSessionInfo } from '../../transport.js';
import { FilterBar } from './FilterBar.js';
import { SessionGroupHeader } from './SessionGroupHeader.js';
import { SessionItem } from './SessionItem.js';
import './session-selector.css';

/** Number of sessions to render initially before "Show more" */
const INITIAL_RENDER_CAP = 30;

export function SessionSelector(): React.JSX.Element {
  const {
    sessions, selectedSessionId, setSelectedSessionId,
    selectedCwd, setSelectedCwd, availableVendors, isLoading,
    findAndSelectSession, sessionStatuses,
  } = useSession();
  const { sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const { channelState } = useSessionStatus(selectedSessionId);
  const transportKind = useEnvironment();
  const allCwds = useAvailableCwds();

  // In websocket mode with workspace routing, CWD changes navigate to the new URL
  const cwdMeta = document.querySelector('meta[name="crispy-cwd"]')?.getAttribute('content');
  const homeMeta = document.querySelector('meta[name="crispy-home"]')?.getAttribute('content');
  const handleCwdChange = useCallback((slug: string | null) => {
    if (transportKind === 'websocket' && cwdMeta && slug) {
      const cwd = allCwds.find(c => c.slug === slug);
      if (cwd && homeMeta) {
        window.location.replace(fsPathToUrlPath(cwd.fullPath, homeMeta));
        return;
      }
    }
    setSelectedCwd(slug);
  }, [transportKind, cwdMeta, homeMeta, allCwds, setSelectedCwd]);

  // ---- Local UI state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [activeVendors, setActiveVendors] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [sessionIdQuery, setSessionIdQuery] = useState('');
  const [sessionIdError, setSessionIdError] = useState('');
  const [sessionIdLoading, setSessionIdLoading] = useState(false);
  const handleSessionIdChange = useCallback((value: string) => {
    setSessionIdQuery(value);
    if (sessionIdError) setSessionIdError('');
  }, [sessionIdError]);
  const deferredQuery = useDeferredValue(searchQuery);
  const listRef = useRef<HTMLUListElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cap visible CWDs to keep the native dropdown manageable
  const MAX_CWDS = 15;
  const availableCwds = useMemo(() => {
    if (allCwds.length <= MAX_CWDS) return allCwds;
    const top = allCwds.slice(0, MAX_CWDS);
    if (selectedCwd && !top.some(c => c.slug === selectedCwd)) {
      const selected = allCwds.find(c => c.slug === selectedCwd);
      if (selected) top.push(selected);
    }
    return top;
  }, [allCwds, selectedCwd]);

  // ---- 5-stage filtering pipeline ----

  // Stage 1: Project filter
  const projectFiltered = useMemo(() => {
    if (!selectedCwd) return sessions;
    return sessions.filter(s => s.projectSlug === selectedCwd);
  }, [sessions, selectedCwd]);

  // Stage 1.5: Filter out system sessions (Rosie, etc)
  const userSessionsOnly = useMemo(() => {
    return projectFiltered.filter(s => s.sessionKind !== 'system');
  }, [projectFiltered]);

  // Stage 2: Vendor filter
  const vendorFiltered = useMemo(() => {
    if (activeVendors.size === 0) return userSessionsOnly;
    return userSessionsOnly.filter(s => activeVendors.has(s.vendor));
  }, [userSessionsOnly, activeVendors]);

  // Stage 3: Search filter
  const searchFiltered = useMemo(() => {
    if (!deferredQuery) return vendorFiltered;
    const q = deferredQuery.toLowerCase();
    return vendorFiltered.filter(s => {
      const titleMatch = s.title?.toLowerCase().includes(q) ?? false;
      const labelMatch = s.label?.toLowerCase().includes(q) ?? false;
      const previewMatch = s.lastMessage?.toLowerCase().includes(q) ?? false;
      return titleMatch || labelMatch || previewMatch;
    });
  }, [vendorFiltered, deferredQuery]);

  // Stage 4: Time grouping
  const grouped = useSessionGrouping(searchFiltered);

  // Stage 5: Render cap (across groups, not per-group)
  const isSearching = deferredQuery.length > 0;
  const bypassCap = isSearching || showAll;

  const { visibleGroups, totalFiltered, hasMore } = useMemo(() => {
    if (bypassCap) {
      return {
        visibleGroups: grouped.groups,
        totalFiltered: grouped.totalCount,
        hasMore: false,
      };
    }

    let remaining = INITIAL_RENDER_CAP;
    const visible: typeof grouped.groups = [];

    for (const group of grouped.groups) {
      if (remaining <= 0) break;
      const sliced = group.sessions.slice(0, remaining);
      visible.push({ ...group, sessions: sliced });
      remaining -= sliced.length;
    }

    const totalVisible = INITIAL_RENDER_CAP - remaining;
    return {
      visibleGroups: visible,
      totalFiltered: grouped.totalCount,
      hasMore: grouped.totalCount > totalVisible,
    };
  }, [grouped, bypassCap]);

  // Build flat list of visible sessions for keyboard navigation
  const flatVisibleSessions = useMemo(() => {
    const flat: WireSessionInfo[] = [];
    for (const group of visibleGroups) {
      flat.push(...group.sessions);
    }
    return flat;
  }, [visibleGroups]);

  // ---- Selection handler ----
  const handleSelect = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setTimeout(() => setSidebarCollapsed(true), 200);
  }, [setSelectedSessionId, setSidebarCollapsed]);

  // ---- Open by ID handler ----
  const handleSessionIdSubmit = useCallback(async () => {
    const id = sessionIdQuery.trim();
    if (!id) return;
    setSessionIdError('');
    setSessionIdLoading(true);
    try {
      const result = await findAndSelectSession(id);
      if (result.found) {
        setSessionIdQuery('');
        setTimeout(() => setSidebarCollapsed(true), 200);
      } else {
        setSessionIdError('Session not found');
      }
    } catch (err) {
      setSessionIdError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setSessionIdLoading(false);
    }
  }, [sessionIdQuery, findAndSelectSession, setSidebarCollapsed]);

  // ---- Keyboard navigation ----
  const onKeyboardSelect = useCallback((index: number) => {
    const session = flatVisibleSessions[index];
    if (session) handleSelect(session.sessionId);
  }, [flatVisibleSessions, handleSelect]);

  const onEscape = useCallback(() => {
    if (searchQuery) {
      setSearchQuery('');
    } else {
      setSidebarCollapsed(true);
    }
  }, [searchQuery, setSidebarCollapsed]);

  const { focusIndex, setFocusIndex, handleKeyDown } = useKeyboardNavigation({
    totalItems: flatVisibleSessions.length,
    onSelect: onKeyboardSelect,
    onEscape,
    listRef,
  });

  // Reset focus when filters change
  useEffect(() => {
    setFocusIndex(-1);
  }, [selectedCwd, activeVendors, deferredQuery, setFocusIndex]);

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (!sidebarCollapsed) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 10);
      return () => clearTimeout(timer);
    }
  }, [sidebarCollapsed]);

  // ---- Vendor toggle ----
  const handleVendorToggle = useCallback((vendor: string) => {
    setActiveVendors(prev => {
      const next = new Set(prev);
      if (next.has(vendor)) {
        next.delete(vendor);
      } else {
        next.add(vendor);
      }
      return next;
    });
  }, []);

  // ---- LIVE badge ----
  const isLiveSession = useCallback((sessionId: string): boolean => {
    // For the selected session, use the precise channelState from the status hook
    if (sessionId === selectedSessionId) {
      return channelState === 'streaming' || channelState === 'awaiting_approval';
    }
    // For other sessions, use the session-list status events
    const status = sessionStatuses.get(sessionId);
    return status === 'streaming' || status === 'awaiting_approval';
  }, [selectedSessionId, channelState, sessionStatuses]);

  // ---- Empty states ----
  if (isLoading) {
    return <div className="crispy-session-empty">Loading...</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="crispy-session-empty-container">
        <FilterBar
          availableCwds={availableCwds}
          selectedCwd={selectedCwd}
          onCwdChange={handleCwdChange}
          availableVendors={availableVendors}
          activeVendors={activeVendors}
          onVendorToggle={handleVendorToggle}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchKeyDown={handleKeyDown}
          searchInputRef={searchInputRef}
          sessionIdQuery={sessionIdQuery}
          onSessionIdChange={handleSessionIdChange}
          onSessionIdSubmit={handleSessionIdSubmit}
          sessionIdError={sessionIdError}
          sessionIdLoading={sessionIdLoading}
        />
        <div className="crispy-session-empty">No conversations found</div>
      </div>
    );
  }

  // ---- Build render output ----
  let globalIndex = 0;

  return (
    <div className="crispy-session-selector">
      <FilterBar
        availableCwds={availableCwds}
        selectedCwd={selectedCwd}
        onCwdChange={handleCwdChange}
        availableVendors={availableVendors}
        activeVendors={activeVendors}
        onVendorToggle={handleVendorToggle}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchKeyDown={handleKeyDown}
        searchInputRef={searchInputRef}
        sessionIdQuery={sessionIdQuery}
        onSessionIdChange={handleSessionIdChange}
        onSessionIdSubmit={handleSessionIdSubmit}
        sessionIdError={sessionIdError}
        sessionIdLoading={sessionIdLoading}
      />

      <ul className="crispy-session-list" ref={listRef}>
          {visibleGroups.map(group => (
            <li key={group.key} className="crispy-session-group">
              <SessionGroupHeader label={group.label} />
              <ul className="crispy-session-group__list">
                {group.sessions.map(session => {
                  const idx = globalIndex++;
                  return (
                    <SessionItem
                      key={session.sessionId}
                      session={session}
                      isSelected={session.sessionId === selectedSessionId}
                      isFocused={idx === focusIndex}
                      isLive={isLiveSession(session.sessionId)}
                      searchQuery={deferredQuery}
                      onClick={() => handleSelect(session.sessionId)}
                      index={idx}
                    />
                  );
                })}
              </ul>
            </li>
          ))}

          {/* Empty state: filters active, no matches */}
          {searchFiltered.length === 0 && (isSearching || activeVendors.size > 0) && (
            <li className="crispy-session-empty">No matches</li>
          )}

          {/* Empty state: no search, no filters, but CWD filter active */}
          {searchFiltered.length === 0 && !isSearching && activeVendors.size === 0 && selectedCwd && (
            <li className="crispy-session-empty">No conversations found</li>
          )}

          {/* Show more button (only when NOT searching) */}
          {hasMore && (
            <li
              className="crispy-session-item crispy-session-item--show-more"
              onClick={() => setShowAll(true)}
            >
              <span className="crispy-session-item__label">
                Show {totalFiltered - flatVisibleSessions.length} more\u2026
              </span>
            </li>
          )}
        </ul>
    </div>
  );
}
