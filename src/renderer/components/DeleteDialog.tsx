import { useState } from 'react';
import { bytes, count } from '../format';
import type { Asset } from '../../shared/types';

/**
 * Confirmation for deleting off the phone.
 *
 * Deliberately awkward: the full list is shown, the word DELETE has to be
 * typed, and the iCloud caveat is stated before the button unlocks. This is the
 * one irreversible action in the app.
 */
export interface DeleteDialogProps {
  assets: Asset[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

export function DeleteDialog({ assets, onCancel, onConfirm, busy }: DeleteDialogProps): JSX.Element {
  const [typed, setTyped] = useState('');
  const totalBytes = assets.reduce((n, a) => n + a.size, 0);
  const armed = typed.trim().toUpperCase() === 'DELETE' && !busy;

  const videos = assets.filter((a) => a.kind === 'video').length;
  const photos = assets.length - videos;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal danger" onClick={(event) => event.stopPropagation()}>
        <h2>Delete {count(assets.length)} item{assets.length === 1 ? '' : 's'} from the iPhone</h2>

        <div className="hint-box danger-box">
          <b>This cannot be undone from here.</b> Files are removed from the phone
          immediately — they do not go to Recently Deleted, and this app cannot bring
          them back.
          <br />
          <br />
          iCloud Photos is on for this library. This removes the file from the phone,
          but the asset stays in your Photos database and iCloud may re-download it.
          To delete for good, and from iCloud, delete in the Photos app.
        </div>

        <div className="prop-row" style={{ borderRadius: 8, border: '1px solid var(--line)' }}>
          <span className="prop-label">Selection</span>
          <span className="prop-value">
            {count(photos)} photo{photos === 1 ? '' : 's'} · {count(videos)} video
            {videos === 1 ? '' : 's'} · {bytes(totalBytes)}
          </span>
        </div>

        <div className="field">
          <label>Everything that will be deleted</label>
          <div className="delete-list">
            {assets.map((asset) => (
              <div key={asset.id} className="delete-row">
                <span>{asset.name}</span>
                <span className="faint">{asset.folder}</span>
                <span className="faint mono">{asset.size ? bytes(asset.size) : ''}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Type DELETE to confirm</label>
          <input
            className="confirm-input"
            value={typed}
            autoFocus
            spellCheck={false}
            disabled={busy}
            placeholder="DELETE"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" disabled={!armed} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete ' + count(assets.length) + ' from iPhone'}
          </button>
        </div>
      </div>
    </div>
  );
}
