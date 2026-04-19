/* global chrome */
import App from './App';
import { createRoot } from 'react-dom/client';
import { installWarnFilter } from './warnFilter';
import './index.css'

installWarnFilter();

chrome.runtime.onMessage.addListener(async function (e) {
    console.log(e);
});

const root = createRoot(document.getElementById('root'));
root.render(
    <App />
);
