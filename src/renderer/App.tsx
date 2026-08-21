import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PhotoGrid } from './components/PhotoGrid';
import { TransferDialog } from './components/TransferDialog';
import { DEFAULT_FILTERS, FilterBar, type FilterState } from './components/FilterBar';
import { PropertiesDialog } from './components/PropertiesDialog';
import { DeleteDialog } from './components/DeleteDialog';
import { bytes, count, duration, rate } from './format';
import type {
  Asset,
  ConnectionState,
  LibraryStats,
  ScanProgress,
  TransferOptions,
  TransferProgress,
} from '../shared/types';

type Filter =
  | 'all'
  | 'photos'
  | 'videos'
  | 'live'
  | 'raw'
  | 'screenshots'
  | 'recordings'
  | 'imported';

const FILTERS: Array<{ id: Filter; label: string; icon: string }> = [
  { id: 'all', label: 'All items', icon: '▦' },
  { id: 'photos', label: 'Photos', icon: '◲' },
  { id: 'videos', label: 'Videos', icon: '▶' },
  { id: 'live', label: 'Live Photos', icon: '◉' },
  { id: 'raw', label: 'RAW', icon: '◈' },
  { id: 'screenshots', label: 'Screenshots', icon: '⧉' },
  { id: 'recordings', label: 'Screen recordings', icon: '⧈' },
  { id: 'imported', label: 'Saved from apps', icon: '⤓' },
];

/**
 * Media the camera did not produce.
 *
 * iOS gives everything an IMG_ name, so the container is the only filesystem
 * signal: the camera writes .MOV and .JPG (and .HEIC/.DNG), never .MP4, .JPEG
 * or .WEBP. Those arrive by being saved out of another app — a messenger, a
 * browser, a download. Which app is not knowable without Photos.sqlite.
 */
const IMPORTED_EXTENSIONS = new Set(['MP4', 'JPEG', 'WEBP', 'GIF', 'M4V', 'AVI', 'BMP', 'TIFF']);
const isImported = (asset: Asset): boolean => IMPORTED_EXTENSIONS.has(asset.ext);

/**
 * Screen recordings are told apart by shape.
 *
 * iOS names them IMG_*.MOV like camera video, but they capture the whole
 * display, so their aspect ratio matches the screen (~2.16:1) rather than the
 * camera's 16:9 or 4:3. Anything more extreme than 1.9:1 on the long axis is a
 * recording; the dimensions come from the movie header.
 */
const RECORDING_ASPECT = 1.9;

/** Screenshots are the PNGs the camera never produces. */
const isScreenshot = (asset: Asset): boolean => asset.ext === 'PNG';

export function App(): JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'idle' });
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [service, setService] = useState<{ daemon: string | null; message?: string } | null>(null);
  const [preview, setPreview] = useState<{ name: string; bytesDone: number; bytesTotal: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [properties, setProperties] = useState<Asset | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Durations are only known once read from each movie header; the duration
  // filter needs them for every candidate, so they are gathered on demand.
  const durationsRef = useRef<
    Map<string, { seconds: number | null; width: number | null; height: number | null }>
  >(new Map());
  const [durationScan, setDurationScan] = useState<{ done: number; total: number } | null>(null);

  // The asset array is mutated in place as metadata streams in; a version
  // counter drives re-renders instead of cloning 35k objects per batch.
  const assetsRef = useRef<Asset[]>([]);
  const byIdRef = useRef<Map<string, Asset>>(new Map());
  const [version, setVersion] = useState(0);
  const bumpTimer = useRef<number | undefined>(undefined);
  const anchorRef = useRef<number | null>(null);

  const bump = useCallback(() => {
    if (bumpTimer.current !== undefined) return;
    bumpTimer.current = window.setTimeout(() => {
      bumpTimer.current = undefined;
      setVersion((v) => v + 1);
    }, 400);
  }, []);

  /* ----------------------------------------------------------- wiring */

  useEffect(() => {
    void window.ios.getState().then(setConnection);
    const offState = window.ios.onState(setConnection);
    const offScan = window.ios.onScanProgress(setScan);
    const offStats = window.ios.onStats(setStats);
    const offTransfer = window.ios.onTransferProgress(setTransfer);
    const offPreview = window.ios.onPreviewProgress((p) => {
      setPreview(p.bytesTotal > 0 && p.bytesDone < p.bytesTotal ? p : null);
    });
    const offMetadata = window.ios.onMetadata((updates) => {
      const map = byIdRef.current;
      for (const update of updates) {
        const asset = map.get(update.id);
        if (asset) {
          asset.size = update.size;
          asset.mtime = update.mtime;
        }
      }
      bump();
    });
    return () => {
      offState();
      offScan();
      offStats();
      offTransfer();
      offPreview();
      offMetadata();
    };
  }, [bump]);

  useEffect(() => {
    if (connection.status !== 'idle') return;
    void window.ios.probeService().then((probe) => {
      setService({ daemon: probe.daemon, message: probe.message });
      if (probe.reachable && probe.deviceCount > 0) void window.ios.connect();
    });
  }, [connection.status]);

  const runScan = useCallback(async () => {
    setSelected(new Set());
    setStats(null);
    const result = await window.ios.scan();
    assetsRef.current = result.assets;
    byIdRef.current = new Map(result.assets.map((a) => [a.id, a]));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (connection.status === 'ready' && assetsRef.current.length === 0) void runScan();
  }, [connection.status, runScan]);

  /* ---------------------------------------------------------- derived */

  const visible = useMemo(() => {
    void version;
    const needle = filters.query.trim().toLowerCase();
    const exts = filters.extensions.length > 0 ? new Set(filters.extensions) : null;

    // Date bounds are inclusive; "to" covers the whole of that day.
    const from = filters.from ? new Date(filters.from + 'T00:00:00').getTime() : null;
    const to = filters.to ? new Date(filters.to + 'T23:59:59.999').getTime() : null;
    const minBytes = filters.minMB ? Number(filters.minMB) * 1e6 : null;
    const maxBytes = filters.maxMB ? Number(filters.maxMB) * 1e6 : null;

    const list = assetsRef.current.filter((asset) => {
      if (!filters.showMotion && asset.motionPart) return false;
      if (filter === 'photos' && asset.kind !== 'photo') return false;
      if (filter === 'videos' && (asset.kind !== 'video' || asset.motionPart)) return false;
      if (filter === 'live' && !asset.live) return false;
      if (filter === 'raw' && asset.kind !== 'raw') return false;
      if (filter === 'screenshots' && !isScreenshot(asset)) return false;
      if (filter === 'imported' && !isImported(asset)) return false;
      if (filter === 'recordings') {
        if (asset.kind !== 'video' || asset.motionPart) return false;
        const info = durationsRef.current.get(asset.id);
        if (!info || !info.width || !info.height) return false;
        const long = Math.max(info.width, info.height);
        const short = Math.min(info.width, info.height);
        if (short <= 0 || long / short < RECORDING_ASPECT) return false;
      }
      if (needle && !asset.name.toLowerCase().includes(needle)) return false;
      if (exts && !exts.has(asset.ext)) return false;
      // Assets still awaiting metadata have no date or size to judge yet, so a
      // range filter cannot include them.
      if ((from !== null || to !== null) && !asset.mtime) return false;
      if (from !== null && asset.mtime < from) return false;
      if (to !== null && asset.mtime > to) return false;
      if (minBytes !== null && asset.size < minBytes) return false;
      if (maxBytes !== null && asset.size > maxBytes) return false;
      return true;
    });

    const dir = filters.sortDir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (filters.sortKey === 'name') return dir * a.name.localeCompare(b.name);
      if (filters.sortKey === 'size') return dir * (a.size - b.size);
      // Date: items without metadata yet keep their DCIM order, which is
      // already chronological, and sit at the end rather than jumbling the top.
      if (a.mtime && b.mtime) return dir * (a.mtime - b.mtime);
      if (a.mtime) return -1;
      if (b.mtime) return 1;
      return 0;
    });
    return list;
  }, [version, filter, filters]);

  const maxSeconds = filters.maxSeconds ? Number(filters.maxSeconds) : null;

  /** Videos whose header has not been read yet, when something needs it. */
  const needDurations = useMemo(() => {
    void version;
    if (maxSeconds === null && filter !== 'recordings') return [];
    const pool = filter === 'recordings' ? assetsRef.current : visible;
    return pool.filter(
      (a) => a.kind === 'video' && !a.motionPart && !durationsRef.current.has(a.id),
    );
  }, [visible, maxSeconds, filter, version]);

  useEffect(() => {
    if (needDurations.length === 0) {
      setDurationScan(null);
      return;
    }
    let cancelled = false;
    const batch = needDurations.slice(0, 400);
    setDurationScan({ done: durationsRef.current.size, total: durationsRef.current.size + needDurations.length });
    void window.ios
      .getDurations(batch.map((a) => ({ id: a.id, size: a.size })))
      .then((found) => {
        if (cancelled) return;
        for (const [id, info] of Object.entries(found)) durationsRef.current.set(id, info);
        setVersion((v) => v + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [needDurations]);

  /** The duration filter is applied after the main pass, once lengths are known. */
  const shown = useMemo(() => {
    void version;
    if (maxSeconds === null) return visible;
    return visible.filter((asset) => {
      if (asset.kind !== 'video') return false;
      const seconds = durationsRef.current.get(asset.id)?.seconds;
      return typeof seconds === 'number' && seconds <= maxSeconds;
    });
  }, [visible, maxSeconds, version]);

  const shownBytes = useMemo(() => shown.reduce((n, a) => n + a.size, 0), [shown]);

  /** Extensions present in the library, most common first. */
  const availableTypes = useMemo(() => {
    void version;
    const tally = new Map<string, number>();
    for (const asset of assetsRef.current) {
      if (asset.motionPart && !filters.showMotion) continue;
      tally.set(asset.ext, (tally.get(asset.ext) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([ext, n]) => ({ ext, n }))
      .sort((a, b) => b.n - a.n);
  }, [version, filters.showMotion]);

  const counts = useMemo(() => {
    void version;
    const result = {
      all: 0, photos: 0, videos: 0, live: 0, raw: 0,
      screenshots: 0, recordings: 0, imported: 0,
    };
    for (const asset of assetsRef.current) {
      if (asset.motionPart && !filters.showMotion) continue;
      result.all++;
      if (asset.kind === 'photo') result.photos++;
      else if (asset.kind === 'video') result.videos++;
      else if (asset.kind === 'raw') result.raw++;
      if (asset.live) result.live++;
      if (isScreenshot(asset)) result.screenshots++;
      if (isImported(asset)) result.imported++;
      if (asset.kind === 'video' && !asset.motionPart) {
        const info = durationsRef.current.get(asset.id);
        if (info?.width && info.height) {
          const long = Math.max(info.width, info.height);
          const short = Math.min(info.width, info.height);
          if (short > 0 && long / short >= RECORDING_ASPECT) result.recordings++;
        }
      }
    }
    return result;
  }, [version, filters.showMotion]);

  const selectedAssets = useMemo(
    () => [...selected].map((id) => byIdRef.current.get(id)).filter((a): a is Asset => Boolean(a)),
    [selected],
  );
  const selectedBytes = selectedAssets.reduce((n, a) => n + a.size, 0);

  // iPhone file names repeat once the camera counter wraps past IMG_9999, so a
  // flat copy can collide. Count the repeats to warn before it matters.
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    let repeats = 0;
    for (const asset of selectedAssets) {
      if (seen.has(asset.name)) repeats++;
      else seen.add(asset.name);
    }
    return repeats;
  }, [selectedAssets]);

  /** Double-click pulls the original across and hands it to the system viewer. */
  const openAsset = useCallback((asset: Asset) => {
    setPreview({ name: asset.name, bytesDone: 0, bytesTotal: asset.size || 1 });
    void window.ios
      .openAsset(asset.id)
      .catch((err) => window.alert('Could not open ' + asset.name + ': ' + (err as Error).message))
      .finally(() => setPreview(null));
  }, []);

  /**
   * Drops short videos from the selection.
   *
   * Durations live in the movie headers, so the ones not already on screen have
   * to be read before they can be judged.
   */
  const dropShortClips = useCallback(async () => {
    const clips = selectedAssets.filter((a) => a.kind === 'video');
    if (clips.length === 0) return;
    setDropping(true);
    try {
      const found = await window.ios.getDurations(
        clips.map((a) => ({ id: a.id, size: a.size })),
      );
      const drop = new Set(
        Object.entries(found)
          .filter(([, info]) => info.seconds !== null && info.seconds < 30)
          .map(([id]) => id),
      );
      if (drop.size === 0) return;
      setSelected((previous) => {
        const next = new Set(previous);
        for (const id of drop) next.delete(id);
        return next;
      });
    } finally {
      setDropping(false);
    }
  }, [selectedAssets]);

  const runDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const result = await window.ios.deleteAssets([...selected]);
      setDeleteOpen(false);
      setSelected(new Set());
      // The index changed on the main side; re-read it rather than guess.
      const fresh = await window.ios.getAssets();
      assetsRef.current = fresh;
      byIdRef.current = new Map(fresh.map((a) => [a.id, a]));
      setVersion((v) => v + 1);
      if (result.failed > 0) {
        const lines = result.errors.map((e) => e.name + ': ' + e.message);
        window.alert(
          ['Deleted ' + result.deleted + ', but ' + result.failed + ' failed:', ...lines].join('\n'),
        );
      }
    } catch (err) {
      window.alert('Delete failed: ' + (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }, [selected]);

  /* -------------------------------------------------------- selection */

  const pick = useCallback(
    (index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      const asset = shown[index];
      if (!asset) return;

      setSelected((previous) => {
        const next = new Set(previous);

        // Shift extends from the last clicked tile, keeping what came before.
        if (event.shiftKey && anchorRef.current !== null) {
          const [from, to] = [anchorRef.current, index].sort((a, b) => a - b);
          for (let i = from; i <= to; i++) {
            const item = shown[i];
            if (item) next.add(item.id);
          }
          anchorRef.current = index;
          return next;
        }

        // Every other click toggles just that tile. Explorer would replace the
        // whole selection here, which in a bulk-copy app means one stray click
        // discards thousands of chosen items — Clear and Escape do that on
        // purpose instead.
        if (next.has(asset.id)) next.delete(asset.id);
        else next.add(asset.id);
        anchorRef.current = index;
        return next;
      });
    },
    [shown],
  );

  const selectSection = useCallback(
    (startIndex: number, sectionCount: number) => {
      setSelected((previous) => {
        const next = new Set(previous);
        for (let i = startIndex; i < startIndex + sectionCount; i++) {
          const item = shown[i];
          if (item) next.add(item.id);
        }
        return next;
      });
    },
    [shown],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(new Set(shown.map((a) => a.id)));
      }
      if (event.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);

  /* --------------------------------------------------------- transfer */

  const startTransfer = useCallback(
    async (options: TransferOptions) => {
      setDialogOpen(false);
      try {
        await window.ios.startTransfer([...selected], options);
      } catch (err) {
        setTransfer(null);
        window.alert('Could not start the transfer: ' + (err as Error).message);
      }
    },
    [selected],
  );

  /* ------------------------------------------------------------ views */

  if (connection.status !== 'ready') {
    return (
      <div className="app">
        <TitleBar connection={connection} />
        <ConnectionScreen
          connection={connection}
          service={service}
          onRetry={() => void window.ios.connect()}
          onStartService={async () => {
            const result = await window.ios.startService();
            if (result.started) setTimeout(() => void window.ios.connect(), 2500);
            else window.alert(result.message ?? 'Could not start the Apple device service.');
          }}
        />
        <div />
      </div>
    );
  }

  const device = connection.device;
  const busy = transfer?.status === 'running';

  return (
    <div className="app">
      <TitleBar connection={connection} />

      <div className="body">
        <aside className="sidebar">
          <h3>Library</h3>
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              className={'nav-item' + (filter === entry.id ? ' active' : '')}
              onClick={() => setFilter(entry.id)}
            >
              <span aria-hidden>{entry.icon}</span>
              <span>{entry.label}</span>
              <span className="count">{count(counts[entry.id])}</span>
            </button>
          ))}

          <h3>On this iPhone</h3>
          <div className="stat-block">
            <div className="row">
              <span>Items</span>
              <b>{count(stats?.total ?? counts.all)}</b>
            </div>
            <div className="row">
              <span>Size</span>
              <b>{stats ? bytes(stats.bytes) : '—'}</b>
            </div>
            <div className="row">
              <span>Free space</span>
              <b>{bytes(device.freeBytes)}</b>
            </div>
          </div>

          <div className="spacer" />
          <ScanStatus scan={scan} onRescan={() => void runScan()} />
        </aside>

        <main className="main">
          <FilterBar
            value={filters}
            onChange={setFilters}
            available={availableTypes}
            shownCount={shown.length}
            shownBytes={shownBytes}
            onSelectAll={() => setSelected(new Set(shown.map((a) => a.id)))}
            onClear={() => setSelected(new Set())}
            canClear={selected.size > 0}
            onDropShortClips={() => void dropShortClips()}
            droppingShortClips={dropping}
          />

          {shown.length === 0 ? (
            <div className="center-state">
              <div className="state-card">
                <div className="state-icon">◲</div>
                <h2>Nothing to show</h2>
                <p>
                  {assetsRef.current.length === 0
                    ? 'Reading the camera roll…'
                    : durationScan
                      ? 'Reading video lengths…'
                      : 'No items match this filter.'}
                </p>
              </div>
            </div>
          ) : (
            <PhotoGrid
              assets={shown}
              grouped={filters.sortKey === 'date'}
              selected={selected}
              onPick={pick}
              onSelectSection={selectSection}
              onOpen={openAsset}
              onProperties={setProperties}
            />
          )}
        </main>
      </div>

      <footer className="transfer-bar">
        {busy && transfer ? (
          <div className="transfer-live">
            <div className="transfer-row">
              <span className="spinner" />
              <span className="mono">
                {count(transfer.filesDone)} / {count(transfer.filesTotal)} files
              </span>
              <div className="progress">
                <div
                  className="progress-fill"
                  style={{
                    width:
                      (transfer.bytesTotal
                        ? (transfer.bytesFlushed / transfer.bytesTotal) * 100
                        : 0) + '%',
                  }}
                />
              </div>
              <span className="mono">
                {bytes(transfer.bytesFlushed)} / {bytes(transfer.bytesTotal)}
              </span>
              <span className="mono">{rate(transfer.bytesPerSecond)}</span>
              <span className="mono dim">
                {transfer.bytesPerSecond > 0 ? duration(transfer.etaSeconds) + ' left' : 'estimating…'}
              </span>
              <button className="btn" onClick={() => void window.ios.cancelTransfer(transfer.jobId)}>
                Cancel
              </button>
            </div>

            <div className="transfer-row detail">
              <span className="faint" title={transfer.destination}>
                → {transfer.destination}
              </span>
              <span className="faint">
                {transfer.writeStreams} write stream{transfer.writeStreams === 1 ? '' : 's'}
                {transfer.mediaKind !== 'unknown' ? ' · ' + transfer.mediaKind.toUpperCase() : ''}
              </span>
              {transfer.filesSkipped > 0 && (
                <span className="faint">{count(transfer.filesSkipped)} already there</span>
              )}
              {transfer.filesFailed > 0 && (
                <span style={{ color: 'var(--bad)' }}>{count(transfer.filesFailed)} failed</span>
              )}
              <div className="spacer" />
              <span className="faint current-files" title={transfer.current.join(', ')}>
                {transfer.current.length > 0 ? transfer.current.join('  ·  ') : 'starting…'}
              </span>
            </div>
          </div>
        ) : transfer && transfer.status !== 'running' ? (
          <>
            <span className={transfer.status === 'done' ? 'mono' : 'mono dim'}>
              {transfer.status === 'done'
                ? '✓ Copied ' + count(transfer.filesDone) + ' files (' + bytes(transfer.bytesDone) + ')'
                : transfer.status === 'cancelled'
                  ? 'Transfer cancelled after ' + count(transfer.filesDone) + ' files'
                  : 'Transfer failed'}
            </span>
            {transfer.filesSkipped > 0 && (
              <span className="dim">{count(transfer.filesSkipped)} already there</span>
            )}
            {transfer.filesFailed > 0 && (
              <span className="dim">{count(transfer.filesFailed)} failed</span>
            )}
            <div className="spacer" />
            <button className="btn" onClick={() => void window.ios.reveal(transfer.destination)}>
              Open folder
            </button>
            <button className="btn ghost" onClick={() => setTransfer(null)}>
              Dismiss
            </button>
          </>
        ) : (
          <>
            {preview ? (
              <>
                <span className="spinner" />
                <span className="dim">
                  Opening {preview.name}
                  {preview.bytesTotal > 1
                    ? ' · ' + bytes(preview.bytesDone) + ' / ' + bytes(preview.bytesTotal)
                    : ''}
                </span>
              </>
            ) : (
              <span className="dim">
                {selected.size === 0
                  ? 'Select to copy · double-click to open'
                  : count(selected.size) + ' selected'}
              </span>
            )}
            {selectedBytes > 0 && <span className="mono faint">{bytes(selectedBytes)}</span>}
            <div className="spacer" />
            <button
              className="btn danger"
              disabled={selected.size === 0}
              onClick={() => setDeleteOpen(true)}
              title="Delete the selected items from the iPhone"
            >
              Delete from iPhone…
            </button>
            <button
              className="btn primary"
              disabled={selected.size === 0}
              onClick={() => setDialogOpen(true)}
            >
              Copy to PC…
            </button>
          </>
        )}
      </footer>

      {deleteOpen && (
        <DeleteDialog
          assets={selectedAssets}
          busy={deleting}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void runDelete()}
        />
      )}

      {properties && (
        <PropertiesDialog
          asset={properties}
          onClose={() => setProperties(null)}
          onOpen={(asset) => {
            setProperties(null);
            openAsset(asset);
          }}
        />
      )}

      {dialogOpen && (
        <TransferDialog
          fileCount={selected.size}
          totalBytes={selectedBytes}
          hasLive={selectedAssets.some((a) => a.live)}
          duplicateNames={duplicateNames}
          onCancel={() => setDialogOpen(false)}
          onStart={startTransfer}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- subviews */

function TitleBar({ connection }: { connection: ConnectionState }): JSX.Element {
  const device = connection.status === 'ready' ? connection.device : null;
  const used = device ? device.capacityBytes - device.freeBytes : 0;
  const pct = device && device.capacityBytes ? (used / device.capacityBytes) * 100 : 0;

  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">⇄</span>
        <span>iOS Transfer</span>
      </div>

      {device && (
        <>
          <div className="device-chip">
            <span className="name">{device.name}</span>
            <span className="meta">
              {device.deviceClass} · iOS {device.iosVersion}
            </span>
            <span
              className={'transport' + (device.connectionType === 'USB' ? ' fast' : '')}
              title={
                device.connectionType === 'USB'
                  ? 'Connected by cable — full speed'
                  : 'Connected over Wi-Fi — roughly 30x slower than a cable'
              }
            >
              {device.connectionType === 'USB' ? 'USB' : 'Wi-Fi'}
            </span>
            {device.batteryLevel !== null && (
              <span className="meta mono">
                {device.batteryCharging ? '⚡' : ''}
                {device.batteryLevel}%
              </span>
            )}
          </div>

          <div className="capacity">
            <div className="capacity-bar">
              <div className="capacity-fill" style={{ width: pct + '%' }} />
            </div>
            <span className="meta mono dim">{bytes(device.freeBytes)} free</span>
          </div>
        </>
      )}
      <div className="spacer" />
    </header>
  );
}

function ScanStatus({
  scan,
  onRescan,
}: {
  scan: ScanProgress | null;
  onRescan: () => void;
}): JSX.Element {
  if (!scan) return <div className="stat-block faint">Reading library…</div>;
  return (
    <div className="stat-block">
      <div className="row">
        <span>{scan.phase === 'done' ? 'Indexed in' : 'Listed in'}</span>
        <b>
          {scan.elapsedMs < 1000
            ? scan.elapsedMs + 'ms'
            : (scan.elapsedMs / 1000).toFixed(1) + 's'}
        </b>
      </div>
      {scan.phase !== 'done' && (
        <div className="row">
          <span>Reading dates</span>
          <b>{count(scan.assetsFound)}</b>
        </div>
      )}
      <button className="btn ghost" style={{ width: '100%', marginTop: 6 }} onClick={onRescan}>
        Rescan device
      </button>
    </div>
  );
}

function ConnectionScreen({
  connection,
  service,
  onRetry,
  onStartService,
}: {
  connection: ConnectionState;
  service: { daemon: string | null; message?: string } | null;
  onRetry: () => void;
  onStartService: () => void;
}): JSX.Element {
  const connecting = connection.status === 'connecting';
  const error = connection.status === 'error' ? connection : null;

  return (
    <div className="center-state">
      <div className="state-card">
        <div className="state-icon">{connecting ? '⇄' : error ? '⚠' : '📱'}</div>
        <h2>
          {connecting
            ? connection.message
            : error
              ? error.message
              : 'Connect your iPhone'}
        </h2>
        <p>
          {connecting
            ? 'Negotiating a trusted session over USB.'
            : error?.hint ??
              'Plug your iPhone into a USB 3 port and unlock it. Photos and videos will appear here.'}
        </p>

        {error && service?.daemon && (
          <div className="hint-box">
            The Apple device service is what carries data over the cable. It was found at
            <br />
            <code>{service.daemon}</code>
            <br />
            If it is not running, nothing can see the phone.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="btn primary" onClick={onRetry} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Try again'}
          </button>
          {error && service?.daemon && (
            <button className="btn" onClick={onStartService}>
              Start Apple device service
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
