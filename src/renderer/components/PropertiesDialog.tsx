import { useEffect, useState } from 'react';
import { bytes, clock, count } from '../format';
import type { Asset } from '../../shared/types';

/** Right-click details for one item. */
export interface PropertiesDialogProps {
  asset: Asset;
  onClose: () => void;
  onOpen: (asset: Asset) => void;
}

const FULL_DATE = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{value}</span>
    </div>
  );
}

export function PropertiesDialog({ asset, onClose, onOpen }: PropertiesDialogProps): JSX.Element {
  const [info, setInfo] = useState<
    { seconds: number | null; width: number | null; height: number | null } | null | undefined
  >(undefined);

  useEffect(() => {
    if (asset.kind !== 'video') return;
    let cancelled = false;
    void window.ios
      .getDurations([{ id: asset.id, size: asset.size }])
      .then((found) => {
        if (!cancelled) setInfo(found[asset.id] ?? null);
      })
      .catch(() => setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [asset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kind =
    asset.kind === 'photo'
      ? asset.live
        ? 'Live Photo'
        : 'Photo'
      : asset.kind === 'video'
        ? asset.motionPart
          ? 'Live Photo video'
          : 'Video'
        : asset.kind === 'raw'
          ? 'RAW image'
          : 'File';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>{asset.name}</h2>

        <div className="prop-list">
          <Row label="Kind" value={kind + ' · ' + asset.ext} />
          <Row
            label="Size"
            value={asset.size ? bytes(asset.size) + '  (' + count(asset.size) + ' bytes)' : 'reading…'}
          />
          <Row
            label="Taken"
            value={asset.mtime ? FULL_DATE.format(new Date(asset.mtime)) : 'reading…'}
          />
          {asset.kind === 'video' && (
            <Row
              label="Duration"
              value={
                info === undefined
                  ? 'reading…'
                  : !info || info.seconds === null
                    ? 'unavailable'
                    : clock(info.seconds) + '  (' + info.seconds.toFixed(1) + 's)'
              }
            />
          )}
          {info && info.width && info.height && (
            <Row label="Dimensions" value={info.width + ' × ' + info.height} />
          )}
          {asset.live && <Row label="Live Photo" value="Yes — the paired video copies with it" />}
          <Row label="Folder" value={asset.folder} />
          <Row label="On device" value={'/DCIM/' + asset.id} />
        </div>

        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText('/DCIM/' + asset.id);
            }}
          >
            Copy path
          </button>
          <button className="btn" onClick={() => onOpen(asset)}>
            Open
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
