import { contextBridge, ipcRenderer } from 'electron';
import type { ComputeDesktopApi, ComputeDesktopState } from '../../contracts/computeDesktop.js';
const api: ComputeDesktopApi = {
  state: () => ipcRenderer.invoke('compute:state') as Promise<ComputeDesktopState>,
  language: locale => ipcRenderer.invoke('compute:language', locale) as Promise<void>,
  command: command => ipcRenderer.invoke('compute:command', command) as Promise<void>,
  open: link => ipcRenderer.invoke('compute:open', link) as Promise<void>,
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: ComputeDesktopState) => listener(state);
    ipcRenderer.on('compute:state', receive);
    return () => { ipcRenderer.removeListener('compute:state', receive); };
  },
};
contextBridge.exposeInMainWorld('compute', api);
