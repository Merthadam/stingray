import type { Handlers } from '../../../../shared/contracts/define';
import type { viewsContract } from '../../../../shared/contracts/views';
import { infraServiceById } from '../../../../shared/views/infra/catalog';
import type { GitService } from '../../../core/git';
import type { ViewService, ViewStateRepository } from '../../../core/views';

export function viewsHandlers(d: { views: ViewService; viewState: ViewStateRepository; git: Pick<GitService, 'workspace'>;
  saveViewAs(root: string, input: Parameters<Handlers<typeof viewsContract>['saveViewAs']>[1]): Promise<{ id: string; file: string }>;
  openExternal(url: string): Promise<void> }): Handlers<typeof viewsContract> {
  return {
    views: async id => d.views.listViews(id, (await d.git.workspace(id)).path),
    // ViewService shares concurrent computations of the same view.
    view: async (id, viewId, options) => d.views.computeView(id, (await d.git.workspace(id)).path, viewId, options),
    viewState: (id, viewId) => d.viewState.get(id, viewId),
    saveViewState: (id, viewId, state) => d.viewState.set(id, viewId, state),
    saveExplanation: async (id, viewId, input) => d.views.saveExplanation(id, (await d.git.workspace(id)).path, viewId, input),
    saveViewAs: async (id, input) => d.saveViewAs((await d.git.workspace(id)).path, input),
    // Only catalog ids are accepted, so the renderer can open nothing but the catalog's fixed documentation URLs.
    openServiceDocs: serviceId => {
      const service = infraServiceById(serviceId);
      if (!service) throw new Error('Unknown cloud service.');
      return d.openExternal(service.docUrl);
    },
  };
}
