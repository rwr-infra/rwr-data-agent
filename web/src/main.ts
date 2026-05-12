import { mount } from 'svelte';
import App from './App.svelte';
import { getInitialTheme, setTheme } from './lib/theme.js';
import './app.css';

setTheme(getInitialTheme());
const app = mount(App, { target: document.getElementById('app')! });

export default app;
