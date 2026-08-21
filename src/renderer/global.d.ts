import type { TransferApi } from '../preload/index';

declare global {
  interface Window {
    ios: TransferApi;
  }
}

export {};
