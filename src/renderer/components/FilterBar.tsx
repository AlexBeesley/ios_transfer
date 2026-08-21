import { useEffect, useRef, useState } from 'react';
import { bytes, count } from '../format';

/** Everything narrowing or ordering the grid, in one place. */
export interface FilterState {
  query: string;
  /** Empty means every type. */
  extensions: string[];
  /** "YYYY-MM-DD", or empty for open-ended. */
  from: string;
  to: string;
  /** Megabytes, as typed. */
  minMB: string;
  maxMB: string;
  /** Seconds; only videos shorter than this are shown. */
  maxSeconds: string;
  sortKey: 'date' | 'size' | 'name';
  sortDir: 'asc' | 'desc';
  showMotion: boolean;
}

export const DEFAULT_FILTERS: FilterState = {
  query: '',
  extensions: [],
  from: '',
  to: '',
  minMB: '',
  maxMB: '',
  maxSeconds: '',
  sortKey: 'date',
  sortDir: 'desc',
  showMotion: false,
};

export function isDefaultFilters(value: FilterState): boolean {
  return (
    value.query === '' &&
    value.extensions.length === 0 &&
    value.from === '' &&
    value.to === '' &&
    value.minMB === '' &&
    value.maxMB === '' &&
    value.maxSeconds === ''
  );
}

const SORT_LABELS: Record<FilterState['sortKey'], string> = {
  date: 'Date',
  size: 'File size',
  name: 'Name',
};

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function TypePicker({
  available,
  chosen,
  onChange,
}: {
  available: Array<{ ext: string; n: number }>;
  chosen: string[];
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const label =
    chosen.length === 0
      ? 'All types'
      : chosen.length <= 2
        ? chosen.join(', ')
        : chosen.length + ' types';

  return (
    <div className="popover-host" ref={ref}>
      <button className={'btn' + (chosen.length ? ' on' : '')} onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <div className="popover">
          <div className="popover-head">
            <span>File type</span>
            <button className="btn ghost tiny" onClick={() => onChange([])}>
              All
            </button>
          </div>
          <div className="popover-list">
            {available.map(({ ext, n }) => {
              const on = chosen.includes(ext);
              return (
                <label key={ext} className="toggle">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onChange(on ? chosen.filter((e) => e !== ext) : [...chosen, ext])
                    }
                  />
                  <span>{ext}</span>
                  <span className="count">{count(n)}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export interface FilterBarProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
  available: Array<{ ext: string; n: number }>;
  shownCount: number;
  shownBytes: number;
  onSelectAll: () => void;
  onClear: () => void;
  canClear: boolean;
  onDropShortClips: () => void;
  droppingShortClips: boolean;
}

export function FilterBar({
  value,
  onChange,
  available,
  shownCount,
  shownBytes,
  onSelectAll,
  onClear,
  canClear,
  onDropShortClips,
  droppingShortClips,
}: FilterBarProps): JSX.Element {
  const set = <K extends keyof FilterState>(key: K, next: FilterState[K]): void =>
    onChange({ ...value, [key]: next });

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <span className="faint">⌕</span>
          <input
            placeholder="Search by file name"
            value={value.query}
            onChange={(event) => set('query', event.target.value)}
          />
        </div>

        <TypePicker
          available={available}
          chosen={value.extensions}
          onChange={(next) => set('extensions', next)}
        />

        <div className="range">
          <span className="faint">Date</span>
          <input
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(event) => set('from', event.target.value)}
          />
          <span className="faint">→</span>
          <input
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(event) => set('to', event.target.value)}
          />
        </div>

        <div className="range">
          <span className="faint">Size MB</span>
          <input
            type="number"
            min={0}
            placeholder="min"
            value={value.minMB}
            onChange={(event) => set('minMB', event.target.value)}
          />
          <span className="faint">→</span>
          <input
            type="number"
            min={0}
            placeholder="max"
            value={value.maxMB}
            onChange={(event) => set('maxMB', event.target.value)}
          />
        </div>

        <div className="range">
          <span className="faint">Clips under</span>
          <input
            type="number"
            min={0}
            step={0.5}
            placeholder="sec"
            value={value.maxSeconds}
            onChange={(event) => set('maxSeconds', event.target.value)}
            title="Show only videos shorter than this many seconds"
          />
          {['1', '2', '5'].map((preset) => (
            <button
              key={preset}
              className={'btn tiny' + (value.maxSeconds === preset ? ' on' : '')}
              onClick={() => set('maxSeconds', value.maxSeconds === preset ? '' : preset)}
            >
              {preset}s
            </button>
          ))}
        </div>

        <div className="spacer" />

        <label className="toggle">
          <input
            type="checkbox"
            checked={value.showMotion}
            onChange={(event) => set('showMotion', event.target.checked)}
          />
          Live Photo videos
        </label>
      </div>

      <div className="toolbar sub">
        <span className="faint">Sort</span>
        {(['date', 'size', 'name'] as const).map((key) => (
          <button
            key={key}
            className={'btn tiny' + (value.sortKey === key ? ' on' : '')}
            onClick={() => set('sortKey', key)}
          >
            {SORT_LABELS[key]}
          </button>
        ))}
        <button
          className="btn tiny"
          title={value.sortDir === 'desc' ? 'Descending' : 'Ascending'}
          onClick={() => set('sortDir', value.sortDir === 'desc' ? 'asc' : 'desc')}
        >
          {value.sortDir === 'desc' ? '↓ Largest / newest first' : '↑ Smallest / oldest first'}
        </button>

        {!isDefaultFilters(value) && (
          <button
            className="btn tiny"
            onClick={() =>
              onChange({ ...DEFAULT_FILTERS, showMotion: value.showMotion, sortKey: value.sortKey, sortDir: value.sortDir })
            }
          >
            ✕ Reset filters
          </button>
        )}

        <div className="spacer" />

        <span className="mono dim">
          {count(shownCount)} shown{shownBytes > 0 ? ' · ' + bytes(shownBytes) : ''}
        </span>
        <button className="btn" onClick={onSelectAll} disabled={shownCount === 0}>
          Select all
        </button>
        <button
          className="btn"
          onClick={onDropShortClips}
          disabled={!canClear || droppingShortClips}
          title="Remove videos shorter than 30 seconds from the selection"
        >
          {droppingShortClips ? 'Checking…' : 'Deselect clips < 30s'}
        </button>
        <button className="btn" onClick={onClear} disabled={!canClear}>
          Clear
        </button>
      </div>
    </>
  );
}
