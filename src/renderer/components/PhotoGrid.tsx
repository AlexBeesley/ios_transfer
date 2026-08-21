import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '../../shared/types';
import { clock } from '../format';

/**
 * Virtualized, date-sectioned asset grid.
 *
 * Only the tiles inside the viewport (plus a small overscan) are mounted, so a
 * 35,000-item library scrolls at the same cost as a 200-item one. Sections
 * store index ranges into the incoming array rather than their own copies of
 * it, which keeps re-layout allocation-free as metadata streams in.
 */

const TILE_TARGET = 156;
const GAP = 6;
const PAD_X = 16;
const PAD_TOP = 12;
const HEADER_HEIGHT = 34;
const SECTION_GAP = 10;
const OVERSCAN_ROWS = 3;

/** Which modifiers were held — the same shape for a click or a key press. */
export interface PickModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface Section {
  key: string;
  label: string;
  count: number;
  startIndex: number;
  rows: number;
  top: number;
  height: number;
}

interface Layout {
  sections: Section[];
  columns: number;
  tileSize: number;
  totalHeight: number;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function dayKey(mtime: number): string {
  if (!mtime) return 'pending';
  const d = new Date(mtime);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function dayLabel(mtime: number): string {
  return mtime ? DAY_FORMAT.format(new Date(mtime)) : 'Date pending';
}

function buildLayout(assets: Asset[], width: number, grouped: boolean): Layout {
  const usable = Math.max(120, width - PAD_X * 2);
  const columns = Math.max(2, Math.floor((usable + GAP) / (TILE_TARGET + GAP)));
  const tileSize = Math.floor((usable - GAP * (columns - 1)) / columns);

  const sections: Section[] = [];
  let cursor = PAD_TOP;

  // Date headers only make sense in date order. Sorting by size or name would
  // otherwise scatter one-item sections down the page, stacking their headers.
  if (!grouped) {
    const rows = Math.ceil(assets.length / columns);
    sections.push({
      key: 'all',
      label: '',
      count: assets.length,
      startIndex: 0,
      rows,
      top: cursor,
      height: rows * (tileSize + GAP) - GAP + SECTION_GAP,
    });
    return { sections, columns, tileSize, totalHeight: cursor + (sections[0]?.height ?? 0) + 24 };
  }

  let index = 0;
  while (index < assets.length) {
    const key = dayKey(assets[index].mtime);
    const startIndex = index;
    while (index < assets.length && dayKey(assets[index].mtime) === key) index++;

    const count = index - startIndex;
    const rows = Math.ceil(count / columns);
    const height = HEADER_HEIGHT + rows * (tileSize + GAP) - GAP + SECTION_GAP;

    sections.push({
      key,
      label: dayLabel(assets[startIndex].mtime),
      count,
      startIndex,
      rows,
      top: cursor,
      height,
    });
    cursor += height;
  }

  return { sections, columns, tileSize, totalHeight: cursor + 24 };
}

/** Index of the last section starting at or before `offset`. */
function findSection(sections: Section[], offset: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].top <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function thumbUrl(asset: Asset): string {
  const encoded = asset.id.split('/').map(encodeURIComponent).join('/');
  return 'thumb://asset/' + encoded + (asset.kind === 'video' ? '?v=1' : '');
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / 1e6;
  return mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : mb.toFixed(0) + ' MB';
}

interface TileProps {
  asset: Asset;
  index: number;
  left: number;
  top: number;
  size: number;
  selected: boolean;
  duration?: number | null;
  onPick: (index: number, modifiers: PickModifiers) => void;
  onOpen: (asset: Asset) => void;
  onProperties: (asset: Asset) => void;
  focused: boolean;
}

function Tile({
  asset,
  index,
  left,
  top,
  size,
  selected,
  duration,
  onPick,
  onOpen,
  onProperties,
  focused,
}: TileProps): JSX.Element {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');

  return (
    <div
      className={'tile' + (selected ? ' selected' : '') + (focused ? ' focused' : '')}
      style={{ left, top, width: size, height: size }}
      onClick={(event) =>
        onPick(index, {
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        })
      }
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpen(asset);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onProperties(asset);
      }}
      title={
        asset.name +
        (asset.size ? ' · ' + formatSize(asset.size) : '') +
        (duration != null ? ' · ' + clock(duration) : '')
      }
    >
      {state !== 'failed' && (
        <img
          src={thumbUrl(asset)}
          alt=""
          draggable={false}
          className={state === 'loaded' ? 'loaded' : ''}
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
        />
      )}
      {state === 'failed' && (
        <div className="tile-fallback">{asset.kind === 'video' ? '▶' : '◲'}</div>
      )}
      {asset.kind === 'video' && (
        <span className="badge">▶ {duration != null ? clock(duration) : asset.ext}</span>
      )}
      {asset.live && <span className="badge">LIVE</span>}
      {asset.kind === 'raw' && <span className="badge">RAW</span>}
      <span className="check">✓</span>
    </div>
  );
}

export interface PhotoGridProps {
  assets: Asset[];
  /** Draw date section headers — only valid when the order is chronological. */
  grouped: boolean;
  selected: Set<string>;
  onPick: (index: number, modifiers: PickModifiers) => void;
  onSelectSection: (startIndex: number, count: number) => void;
  onOpen: (asset: Asset) => void;
  onProperties: (asset: Asset) => void;
}

export function PhotoGrid({
  assets,
  grouped,
  selected,
  onPick,
  onSelectSection,
  onOpen,
  onProperties,
}: PhotoGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [height, setHeight] = useState(700);
  const [scrollTop, setScrollTop] = useState(0);
  const [durations, setDurations] = useState<Map<string, number | null>>(new Map());
  // The keyboard cursor, independent of what is selected.
  const [focus, setFocus] = useState(-1);
  const frame = useRef(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setHeight(element.clientHeight);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(scrollRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const layout = useMemo(() => buildLayout(assets, width, grouped), [assets, width, grouped]);

  // Reset to the top whenever the underlying set changes shape enough that the
  // old scroll offset would be meaningless.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [assets.length]);

  const { visible, prefetch, videoRequests } = useMemo(() => {
    const { sections, columns, tileSize } = layout;
    const nodes: JSX.Element[] = [];
    const upcoming: Array<{ id: string; isVideo: boolean }> = [];
    const videos: Array<{ id: string; size: number }> = [];
    if (sections.length === 0) return { visible: nodes, prefetch: upcoming, videoRequests: videos };

    const rowStride = tileSize + GAP;
    const viewTop = scrollTop - OVERSCAN_ROWS * rowStride;
    const viewBottom = scrollTop + height + OVERSCAN_ROWS * rowStride;

    for (let s = findSection(sections, viewTop); s < sections.length; s++) {
      const section = sections[s];
      if (section.top > viewBottom) break;

      const headerHeight = section.label ? HEADER_HEIGHT : 0;
      if (section.label) {
        nodes.push(
          <div
            key={'h-' + section.key}
            className="section-header"
            style={{ top: section.top, height: HEADER_HEIGHT }}
          >
            <span>{section.label}</span>
            <span className="sub">{section.count.toLocaleString()}</span>
            <button
              className="pick"
              onClick={(event) => {
                event.stopPropagation();
                onSelectSection(section.startIndex, section.count);
              }}
            >
              Select all
            </button>
          </div>,
        );
      }

      const gridTop = section.top + headerHeight;
      const firstRow = Math.max(0, Math.floor((viewTop - gridTop) / rowStride));
      const lastRow = Math.min(section.rows - 1, Math.ceil((viewBottom - gridTop) / rowStride));

      for (let row = firstRow; row <= lastRow; row++) {
        for (let col = 0; col < columns; col++) {
          const offset = row * columns + col;
          if (offset >= section.count) break;
          const index = section.startIndex + offset;
          const asset = assets[index];
          if (asset.kind === 'video' && !durations.has(asset.id)) {
            videos.push({ id: asset.id, size: asset.size });
          }
          nodes.push(
            <Tile
              key={asset.id}
              asset={asset}
              index={index}
              left={PAD_X + col * (tileSize + GAP)}
              top={gridTop + row * rowStride}
              size={tileSize}
              selected={selected.has(asset.id)}
              focused={index === focus}
              duration={durations.get(asset.id)}
              onPick={onPick}
              onOpen={onOpen}
              onProperties={onProperties}
            />,
          );
        }
      }

      // Queue the two rows past the fold so scrolling stays ahead of the device.
      const aheadStart = section.startIndex + (lastRow + 1) * columns;
      for (let i = aheadStart; i < Math.min(aheadStart + columns * 2, section.startIndex + section.count); i++) {
        upcoming.push({ id: assets[i].id, isVideo: assets[i].kind === 'video' });
      }
    }

    return { visible: nodes, prefetch: upcoming, videoRequests: videos };
  }, [assets, layout, scrollTop, height, selected, durations, focus, onPick, onSelectSection, onOpen, onProperties]);

  useEffect(() => {
    if (prefetch.length === 0) return;
    const timer = setTimeout(() => void window.ios.prefetchThumbs(prefetch), 90);
    return () => clearTimeout(timer);
  }, [prefetch]);

  // Durations are read from each movie's header on demand, so only ask for the
  // videos actually on screen and remember the answers (including failures).
  useEffect(() => {
    if (videoRequests.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.ios
        .getDurations(videoRequests)
        .then((found) => {
          if (cancelled || Object.keys(found).length === 0) return;
          setDurations((previous) => {
            const next = new Map(previous);
            for (const [id, info] of Object.entries(found)) next.set(id, info.seconds);
            return next;
          });
        })
        .catch(() => undefined);
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [videoRequests]);

  /** Brings an index into view, accounting for its section header. */
  const revealIndex = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const { sections, columns, tileSize } = layout;
      const section = sections.find(
        (sec) => index >= sec.startIndex && index < sec.startIndex + sec.count,
      );
      if (!section) return;
      const row = Math.floor((index - section.startIndex) / columns);
      const headerHeight = section.label ? HEADER_HEIGHT : 0;
      const top = section.top + headerHeight + row * (tileSize + GAP);
      if (top < element.scrollTop) element.scrollTo({ top: top - 8 });
      else if (top + tileSize > element.scrollTop + element.clientHeight) {
        element.scrollTo({ top: top + tileSize - element.clientHeight + 8 });
      }
    },
    [layout],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (assets.length === 0) return;
      const { columns } = layout;
      const current = focus < 0 ? 0 : focus;
      let next = current;

      switch (event.key) {
        case 'ArrowRight': next = current + 1; break;
        case 'ArrowLeft': next = current - 1; break;
        case 'ArrowDown': next = current + columns; break;
        case 'ArrowUp': next = current - columns; break;
        case 'Home': next = 0; break;
        case 'End': next = assets.length - 1; break;
        case 'PageDown': next = current + columns * 4; break;
        case 'PageUp': next = current - columns * 4; break;
        case ' ':
          event.preventDefault();
          if (focus >= 0) onPick(focus, { shiftKey: false, ctrlKey: true, metaKey: false });
          return;
        case 'Enter':
          event.preventDefault();
          if (focus >= 0 && assets[focus]) onOpen(assets[focus]);
          return;
        default:
          return;
      }

      event.preventDefault();
      next = Math.max(0, Math.min(assets.length - 1, next));
      setFocus(next);
      revealIndex(next);
      // Holding shift while moving extends the selection, as in a file list.
      if (event.shiftKey) onPick(next, { shiftKey: true, ctrlKey: false, metaKey: false });
    },
    [assets, focus, layout, onOpen, onPick, revealIndex],
  );

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={onScroll}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="grid-canvas" style={{ height: layout.totalHeight }}>
        {visible}
      </div>
    </div>
  );
}
