import { useEffect, useState } from 'react';
import { bytes, count } from '../format';
import type { TransferOptions } from '../../shared/types';

export interface TransferDialogProps {
  fileCount: number;
  totalBytes: number;
  hasLive: boolean;
  /** How many selected files share a name with another selected file. */
  duplicateNames: number;
  onCancel: () => void;
  onStart: (options: TransferOptions) => void;
}

export function TransferDialog({
  fileCount,
  totalBytes,
  hasLive,
  duplicateNames,
  onCancel,
  onStart,
}: TransferDialogProps): JSX.Element {
  const [options, setOptions] = useState<TransferOptions | null>(null);
  const [free, setFree] = useState<number | null>(null);

  useEffect(() => {
    void window.ios.getSettings().then(setOptions);
  }, []);

  // Check the destination volume has room before the copy starts, not after.
  useEffect(() => {
    if (!options?.destination) return;
    let cancelled = false;
    void window.ios
      .freeSpace(options.destination)
      .then((result) => {
        if (!cancelled) setFree(result.free);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [options?.destination]);

  const update = <K extends keyof TransferOptions>(key: K, value: TransferOptions[K]): void => {
    setOptions((previous) => (previous ? { ...previous, [key]: value } : previous));
  };

  const choose = async (): Promise<void> => {
    const picked = await window.ios.chooseFolder(options?.destination);
    if (picked) update('destination', picked);
  };

  const start = (): void => {
    if (!options) return;
    void window.ios.saveSettings(options);
    onStart(options);
  };

  // Only a flat copy can collide; dated folders separate the repeats.
  const collisionRisk = Boolean(options && !options.organizeByDate && duplicateNames > 0);
  const wouldSkip = collisionRisk && options?.onConflict === 'skip';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>
          Copy {count(fileCount)} item{fileCount === 1 ? '' : 's'}
          {totalBytes > 0 && <span className="dim"> · {bytes(totalBytes)}</span>}
        </h2>

        {!options ? (
          <p className="dim">Loading preferences…</p>
        ) : (
          <>
            <div className="field">
              <label>Destination</label>
              <div className="path-row">
                <div className="path" title={options.destination}>
                  {options.destination}
                </div>
                <button className="btn" onClick={() => void choose()}>
                  Browse…
                </button>
              </div>
            </div>

            <div className="field">
              <label>If a file already exists</label>
              <div className="seg">
                {(['skip', 'rename', 'overwrite'] as const).map((mode) => (
                  <button
                    key={mode}
                    className={options.onConflict === mode ? 'on' : ''}
                    onClick={() => update('onConflict', mode)}
                  >
                    {mode === 'skip' ? 'Skip' : mode === 'rename' ? 'Keep both' : 'Replace'}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Options</label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.organizeByDate}
                  onChange={(event) => update('organizeByDate', event.target.checked)}
                />
                Sort into year and month folders
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.preserveDates}
                  onChange={(event) => update('preserveDates', event.target.checked)}
                />
                Keep original capture dates
              </label>
              <label className="toggle" style={{ opacity: hasLive ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={options.includeMotion}
                  disabled={!hasLive}
                  onChange={(event) => update('includeMotion', event.target.checked)}
                />
                Include Live Photo videos
              </label>
            </div>

            {free !== null && (
              <div
                className="hint-box"
                style={
                  free < totalBytes ? { borderColor: 'var(--bad)', color: '#f6c9cf' } : undefined
                }
              >
                {free < totalBytes
                  ? '⚠ Not enough room. This copy needs ' + bytes(totalBytes) +
                    ' but only ' + bytes(free) + ' is free on the destination drive.'
                  : 'Destination has ' + bytes(free) + ' free — ' +
                    bytes(free - totalBytes) + ' would remain after this copy.'}
              </div>
            )}

            {collisionRisk && (
              <div className="hint-box" style={wouldSkip ? { borderColor: 'var(--warn)' } : undefined}>
                {wouldSkip ? '⚠ ' : ''}
                {count(duplicateNames)}{' '}
                {duplicateNames === 1 ? 'file shares' : 'of these files share'} a name with another
                file in this selection — the camera counter wraps past IMG_9999 and starts over.{' '}
                {wouldSkip
                  ? 'With “Skip” they will not be copied. Choose “Keep both” to keep every file.'
                  : 'They will be saved as “name (1)”, “name (2)” and so on.'}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn primary" disabled={!options.destination} onClick={start}>
                Start copy
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
