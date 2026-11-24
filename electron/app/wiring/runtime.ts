// Runtime core + real adapters under the names and signatures main and the existing tests use.
import type { LiveViewEvent } from '../../../shared/contracts/runtime';
import { webCdp } from '../../adapters/driven/cdp/cdp-connection';
import { nodeDockerSocketFiles, runDocker } from '../../adapters/driven/docker/docker-runner';
import { psLsof } from '../../adapters/driven/process/ps-lsof';
import * as core from '../../core/runtime';

export class PortService extends core.PortService {
  constructor(roots: () => core.PortRoot[], runner: core.PortScanner = psLsof, platform: string = process.platform) { super(roots, runner, platform); }
}
export class ContainerService extends core.ContainerService {
  constructor(run: core.DockerRunner = runDocker, env: Record<string, string | undefined> = process.env) { super(run, env, nodeDockerSocketFiles); }
}
export class LiveViews extends core.LiveViews { constructor(publish: (event: LiveViewEvent) => void) { super(publish, { cdp: webCdp }); } }
export { processOwners, parseListeners, inspectFormat, parseContainers, APP_PAGE, MAX_LIVE_VIEWS, pickTarget, toCdpInput, type PortRoot } from '../../core/runtime';
