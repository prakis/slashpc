'use strict';

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js';

function setStatus(text, ready) {
  const badge = document.getElementById('python-status');
  if (!badge) return;
  badge.textContent = text;
  if (ready) {
    badge.classList.add('python-ready');
    badge.classList.remove('python-loading');
  } else {
    badge.classList.add('python-loading');
    badge.classList.remove('python-ready');
  }
}

async function initPyodide() {
  // loadPyodide is injected globally by the CDN script added to index.html
  if (typeof window.loadPyodide !== 'function') {
    console.warn('[pyodide] loadPyodide not available yet');
    return;
  }

  try {
    setStatus('Python: loading…', false);

    const pyodide = await window.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/',
    });

    setStatus('Python: installing numpy…', false);
    await pyodide.loadPackage('numpy');

    // Expose globally so users can interact via the browser console
    window.pyodide = pyodide;

    setStatus('Python ✓', true);
    console.info('[pyodide] Ready. Use window.pyodide to access the Python runtime.');
    console.info('[pyodide] Example: pyodide.runPython("import numpy as np; print(np.__version__)")');
  } catch (err) {
    setStatus('Python ✗', false);
    console.error('[pyodide] Failed to load:', err);
  }
}

// Load the Pyodide CDN script dynamically, then initialise
function start() {
  window.addEventListener('DOMContentLoaded', () => {
    const script = document.createElement('script');
    script.src = PYODIDE_CDN;
    script.onload = () => initPyodide();
    script.onerror = () => {
      setStatus('Python ✗', false);
      console.error('[pyodide] Failed to load Pyodide script from CDN.');
    };
    document.head.appendChild(script);
  });
}

module.exports.start = start;
