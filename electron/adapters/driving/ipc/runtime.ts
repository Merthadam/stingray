import type { Handlers } from '../../../../shared/contracts/define';
import type { runtimeContract } from '../../../../shared/contracts/runtime';
import type { ContainerService, LiveViews, PortService } from '../../../core/runtime';

export function runtimeHandlers(d: { containers: ContainerService; ports: PortService; liveViews: LiveViews; inspectCdp(port: number): Promise<{ address: string; opened: boolean }> }): Handlers<typeof runtimeContract> {
  return {
    containers: () => d.containers.list(),
    stopContainer: id => d.containers.stop(id),
    containerLogs: id => d.containers.logs(id),
    inspectCdp: port => d.inspectCdp(port),
    ports: () => d.ports.list(),
    liveViewStart: options => d.liveViews.start(options),
    liveViewInput: (id, input) => d.liveViews.input(id, input),
    liveViewResize: (id, maxWidth, maxHeight) => d.liveViews.resize(id, maxWidth, maxHeight),
    liveViewStop: id => d.liveViews.stop(id),
    liveViewAck: id => d.liveViews.ack(id),
  };
}
