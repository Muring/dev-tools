import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('bootstrap', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  catalog: () => ipcRenderer.invoke('catalog'),
  save: (config: unknown) => ipcRenderer.invoke('save', config),
  inspect: () => ipcRenderer.invoke('inspect'),
  previewContent: () => ipcRenderer.invoke('content-preview'),
  updateContent: () => ipcRenderer.invoke('content-update'),
  prepare: () => ipcRenderer.invoke('prepare'),
  installOrca: () => ipcRenderer.invoke('orca-install'),
  install: () => ipcRenderer.invoke('install'),
  run: (step?: string) => ipcRenderer.invoke('run', step),
  stop: () => ipcRenderer.invoke('stop'),
  login: (tool: string) => ipcRenderer.invoke('login', tool),
  shutdown: () => ipcRenderer.invoke('shutdown'),
  reboot: () => ipcRenderer.invoke('reboot'),
  discoverSetup: (skill: string) => ipcRenderer.invoke('setup-discover', skill),
  previewSetup: (request: unknown) => ipcRenderer.invoke('setup-preview', request),
  executeSetup: (id: string, credentials: unknown = {}) =>
    ipcRenderer.invoke('setup-execute', id, credentials),
  openSetupArtifact: (id: string, index: number) => ipcRenderer.invoke('setup-artifact', id, index),
  setupGuide: (skill: string) => ipcRenderer.invoke('setup-guide', skill),
  logs: () => ipcRenderer.invoke('logs'),
});
