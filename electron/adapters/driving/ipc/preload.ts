import { contextBridge, ipcRenderer } from 'electron';
import { contracts } from '../../../../shared/contracts';
import { buildPreloadApi } from './build-api';

contextBridge.exposeInMainWorld('stingray', buildPreloadApi(contracts, ipcRenderer));
