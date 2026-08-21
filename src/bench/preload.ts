import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bench', {
  thumbs: (count: number): Promise<ArrayBuffer[]> => ipcRenderer.invoke('thumbs', count),
});
