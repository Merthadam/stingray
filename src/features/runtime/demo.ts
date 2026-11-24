import type { Events, Invoke } from '../../../shared/contracts/define';
import type { runtimeContract } from '../../../shared/contracts/runtime';
import type { DemoContext } from '../../shared/demo-context';

let demoTestEnvStopped = false;

export function createRuntimeDemo(ctx: DemoContext): Invoke<typeof runtimeContract> & Events<typeof runtimeContract> {
  return {
    containers: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return [{ id: 'demo-web', name: 'demo-web', image: 'node:24', state: 'running', health: 'healthy', paths: ctx.state.workspaces.slice(0, 1).map(w => w.path), ports: [{ port: 3000, target: '3000/tcp', url: 'http://127.0.0.1:3000' }] }, { id: 'demo-db', name: 'demo-db', image: 'postgres:17', state: 'running', health: '', paths: [], ports: [] },
      ...(demoTestEnvStopped ? [] : [{ id: 'demo-test-env', name: 'stingray-test-demo', image: 'stingray-test-env:demo', state: 'running', health: '', testEnv: true, paths: ctx.state.workspaces.slice(0, 1).map(w => w.path), ports: [{ port: 9223, target: '9223/tcp', url: 'http://127.0.0.1:9223', cdp: true as const }] }])]; },
    stopContainer: async () => { demoTestEnvStopped = true; },
    containerLogs: async () => '2026-01-01T00:00:00Z Simulated demo test environment logs.\n2026-01-01T00:00:01Z DevTools listening on ws://127.0.0.1:9222',
    inspectCdp: async port => ({ address: `127.0.0.1:${port}`, opened: false }),
    ports: async () => { await new Promise(resolve => setTimeout(resolve, 650)); return []; },
    liveViewStart: async () => { throw new Error('Live view is unavailable in the browser demo. It needs the desktop app and a running test instance.'); },
    liveViewInput: async () => undefined,
    liveViewResize: async () => undefined,
    liveViewStop: async () => undefined,
    liveViewAck: async () => undefined,
    onLiveView: () => () => {},
  };
}
