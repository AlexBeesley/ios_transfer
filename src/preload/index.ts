import { contextBridge, ipcRenderer } from 'electron';
import type { VideoInfo } from '../main/library/duration';
import type {
  Asset,
  ConnectionState,
  LibraryStats,
  ScanProgress,
  TransferOptions,
  TransferProgress,
} from '../shared/types';

/** Narrow, typed surface exposed to the renderer. No node access leaks through. */

type Unsubscribe = () => void;

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  getState: (): Promise<ConnectionState> => ipcRenderer.invoke('device:state'),
  connect: (): Promise<ConnectionState> => ipcRenderer.invoke('device:connect'),
  disconnect: (): Promise<void> => ipcRenderer.invoke('device:disconnect'),

  probeService: (): Promise<{
    reachable: boolean;
    deviceCount: number;
    daemon: string | null;
    message?: string;
  }> => ipcRenderer.invoke('service:probe'),
  startService: (): Promise<{ started: boolean; message?: string }> =>
    ipcRenderer.invoke('service:start'),

  scan: (): Promise<{ assets: Asset[]; listMs: number }> => ipcRenderer.invoke('library:scan'),
  getAssets: (): Promise<Asset[]> => ipcRenderer.invoke('library:assets'),
  prefetchThumbs: (ids: Array<{ id: string; isVideo: boolean }>): Promise<void> =>
    ipcRenderer.invoke('thumbs:prefetch', ids),
  getDurations: (
    requests: Array<{ id: string; size: number }>,
  ): Promise<Record<string, VideoInfo>> => ipcRenderer.invoke('media:durations', requests),

  chooseFolder: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:chooseFolder', current),
  picturesPath: (): Promise<string> => ipcRenderer.invoke('paths:pictures'),
  freeSpace: (target: string): Promise<{ free: number | null }> =>
    ipcRenderer.invoke('paths:freeSpace', target),
  getSettings: (): Promise<TransferOptions> => ipcRenderer.invoke('settings:get'),
  saveSettings: (value: TransferOptions): Promise<TransferOptions> =>
    ipcRenderer.invoke('settings:save', value),
  reveal: (target: string): Promise<void> => ipcRenderer.invoke('shell:reveal', target),
  openAsset: (assetId: string): Promise<{ path: string; reused: boolean }> =>
    ipcRenderer.invoke('asset:open', assetId),
  deleteAssets: (
    assetIds: string[],
  ): Promise<{
    deleted: number;
    failed: number;
    errors: Array<{ name: string; message: string }>;
  }> => ipcRenderer.invoke('assets:delete', assetIds),

  startTransfer: (
    assetIds: string[],
    options: TransferOptions,
  ): Promise<{ jobId: string; filesTotal: number; bytesTotal: number }> =>
    ipcRenderer.invoke('transfer:start', { assetIds, options }),
  cancelTransfer: (jobId: string): Promise<void> => ipcRenderer.invoke('transfer:cancel', jobId),

  onState: (handler: (state: ConnectionState) => void): Unsubscribe =>
    subscribe('device:state', handler),
  onScanProgress: (handler: (progress: ScanProgress) => void): Unsubscribe =>
    subscribe('library:progress', handler),
  onMetadata: (
    handler: (updates: Array<{ id: string; size: number; mtime: number }>) => void,
  ): Unsubscribe => subscribe('library:metadata', handler),
  onStats: (handler: (stats: LibraryStats) => void): Unsubscribe =>
    subscribe('library:stats', handler),
  onTransferProgress: (handler: (progress: TransferProgress) => void): Unsubscribe =>
    subscribe('transfer:progress', handler),
  onTransferError: (handler: (payload: { jobId: string; message: string }) => void): Unsubscribe =>
    subscribe('transfer:error', handler),
  onPreviewProgress: (
    handler: (payload: { name: string; bytesDone: number; bytesTotal: number }) => void,
  ): Unsubscribe => subscribe('preview:progress', handler),
};

export type TransferApi = typeof api;

contextBridge.exposeInMainWorld('ios', api);
