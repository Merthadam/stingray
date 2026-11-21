// URLs of the vendored cloud service icons (src/assets/infra-icons/<service id>.svg), bundled by Vite.
let urls: Record<string, string> = {};
try {
  urls = import.meta.glob<string>('../assets/infra-icons/*/*.svg', { query: '?url', import: 'default', eager: true });
} catch { /* not bundled by Vite (unit tests import the diagram components): no icons */ }

export const infraIconUrl = (id: string): string | undefined => urls[`../assets/infra-icons/${id}.svg`];
