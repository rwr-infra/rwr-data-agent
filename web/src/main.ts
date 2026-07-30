import { mount } from 'svelte';
import App from './App.svelte';
import { getInitialTheme, setTheme } from './lib/theme.js';
import { consumeUrlReset } from './lib/reset.js';
import './app.css';

// `?reset=1` runs before Svelte mounts: when a stored session is bad enough to throw during the
// first render, the in-app reset button never gets drawn. Returns true while the wipe navigates.
const resetting = consumeUrlReset();

let app: ReturnType<typeof mount> | undefined;
if (!resetting) {
  setTheme(getInitialTheme());
  app = mount(App, { target: document.getElementById('app')! });
}

export default app;
