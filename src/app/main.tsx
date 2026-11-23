import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './workspace-chrome.css';
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="welcome"><h1>Something interrupted the workspace.</h1><p>Your Git files have not been changed by this screen.</p><button onClick={() => location.reload()}>Reload Stingray</button></main> : this.props.children; }
}
import('./App').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
}, (error: Error) => {
  if (error?.name !== 'BridgeMissingError') throw error;
  const main = document.createElement('main'); main.className = 'welcome';
  const h1 = document.createElement('h1'); h1.textContent = 'Stingray desktop bridge is missing: the preload script did not load. Check the main-process log.';
  main.append(h1); document.getElementById('root')!.replaceChildren(main);
});
