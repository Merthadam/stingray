import { contextBridge, ipcRenderer } from 'electron';
import { contracts } from '../shared/contracts';
import { buildPreloadApi } from './adapters/driving/ipc/build-api';

contextBridge.exposeInMainWorld('stingray', buildPreloadApi(contracts, ipcRenderer));
