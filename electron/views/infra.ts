// Cloud services of infra views: nodes of the builtin terraform and cdk sets get the catalog service they deploy, and
// groups whose service nodes are all of one cloud get that provider, so the renderer draws them like AWS/Azure diagrams.
import type { DiagramGroup, DiagramNode } from '../../src/views';
import { CDK_CONSTRUCT, cdkService, terraformService, type InfraProvider, type InfraService } from '../../src/infra/catalog';
import type { ResolvedView } from './rules/types';

export function withInfraServices(view: Pick<ResolvedView, 'rules'>, nodes: DiagramNode[], groups: DiagramGroup[]) {
  const sources = new Set(view.rules.map(r => r.source));
  const terraform = sources.has('builtin/terraform'), cdk = sources.has('builtin/cdk');
  if (!terraform && !cdk) return { nodes, groups };
  // Node ids of the terraform set: "type.name" (resource) and "data.type.name" (data source).
  const serviceOf = (n: DiagramNode): InfraService | null =>
    terraform && n.kind === 'resource' ? terraformService(n.id.split('.')[0])
      : terraform && n.kind === 'data' ? terraformService(n.id.split('.')[1] ?? '')
      : cdk && n.kind === 'construct' ? (n.subtitle && cdkService(n.subtitle)) || CDK_CONSTRUCT
      : cdk && n.kind === 'stack' ? cdkService('Stack') : null;
  const providers = new Map<string, Set<InfraProvider>>();
  const enriched = nodes.map(n => {
    const service = serviceOf(n);
    if (!service) return n;
    if (n.group) providers.set(n.group, (providers.get(n.group) ?? new Set()).add(service.provider));
    return { ...n, service };
  });
  return { nodes: enriched, groups: groups.map(g => {
    const p = providers.get(g.id);
    return p?.size === 1 ? { ...g, provider: [...p][0] } : g;
  }) };
}
