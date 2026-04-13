# /PC — Linux PC in your Browser

A full Linux shell that runs entirely in the browser — no server, no install, no Docker.
Files you save persist across browser restarts. Python (via Pyodide + NumPy) runs alongside it.

Built for learning and experimentation. Everything is client-side.

---

## Features

- **Full Linux shell** — BusyBox Linux 4.15.7 booted inside a v86 x86 emulator
- **Persistent files** — anything saved to `/mnt` is stored in IndexedDB and survives browser restarts
- **Fast subsequent loads** — VM state is cached after the first boot; next visit resumes in 2–4 seconds
- **Python runtime** — Pyodide (Python 3.11 WASM) with NumPy loads in the background; access via `window.pyodide` in the browser console
- **Drag & drop files** — drag files from your desktop into the page to import them into `/mnt`
- **No backend** — everything runs in the browser; no data leaves your machine

---

## Tech Stack

| Layer | Library |
|---|---|
| x86 CPU emulator | [v86](https://github.com/humphd/v86/tree/filer-9p-lastknowngood) (fork with 9P support) |
| Terminal UI | [xterm.js](https://xtermjs.org/) |
| Browser filesystem | [Filer](https://github.com/filerjs/filer) (IndexedDB-backed POSIX FS) |
| FS → VM bridge | 9P protocol (Plan 9 resource sharing) |
| Python runtime | [Pyodide](https://pyodide.org/) — CPython 3.11 compiled to WebAssembly |
| Service worker | [nohost](https://github.com/humphd/nohost) + [Workbox](https://developer.chrome.com/docs/workbox/) |
| Bundler | [Parcel](https://parceljs.org/) v1 |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 14 or later
- npm

### Install

```bash
git clone https://github.com/prakis/slashpc.git
cd slashpc
npm install
```

### Build

```bash
npm run build
```

This bundles the app into `dist/`, copies the Linux binary files, and downloads the service worker from unpkg. Requires an internet connection on first build.

### Run locally

```bash
npm run serve
```

Opens a static server at `http://localhost:3000`. Open it in your browser.

> **First load:** The browser downloads ~6.5 MB (Linux OS + emulator) and boots the VM cold (~15–30s). Everything is cached after that — subsequent loads take 2–4 seconds.

### Dev mode (hot reload)

```bash
npm run dev
```

Starts Parcel's dev server at `http://localhost:1234` with hot module reload for JS/CSS changes.

> **Note:** Run `npm run build` at least once before `npm run dev` so the service worker and `bin/` files exist in `dist/`. Without this, the filesystem bridge won't work.

---

## Using the Shell

### Persistent files

Save all your work inside `/mnt` — this is the persistent filesystem backed by IndexedDB:

```sh
cd /mnt
echo "print('hello')" > hello.py
mkdir projects
```

Files outside `/mnt` (e.g. `/root`, `/tmp`) live only in the emulated VM's RAM and are lost on reload.

### Python

Once the `Python ✓` badge appears in the top bar, Python is ready. Use it from the browser console (F12):

```js
// Run Python directly
pyodide.runPython("import numpy as np; print(np.__version__)")

// Run a .py file you saved in /mnt
fs.readFile('/mnt/hello.py', 'utf8', (err, code) => pyodide.runPython(code))
```

### Drag & drop

Drag any file from your desktop onto the page — it will be imported into `/mnt/<filename>`.

---

## Project Structure

```
src/
  index.html          # Main page
  faq.html            # FAQ page
  index.js            # Entry point
  terminal.js         # xterm.js setup + resize handling
  vm.js               # v86 boot, warm/cold boot, serial I/O
  filesystem.js       # Filer setup, drag-and-drop import
  pyodide-loader.js   # Pyodide + NumPy background loader
  server.js           # Workbox service worker registration
  cache.js            # VM state cache (Cache Storage)
  config.js           # Theme, emulator options, paths
  styles.css          # Main styles
  faq.css             # FAQ page styles
  bin/
    v86-linux.iso     # Linux OS image (~5.4 MB)
    seabios.bin       # BIOS for the emulator
    vgabios.bin       # VGA BIOS for the emulator
scripts/
  copybin.js          # Cross-platform: copies src/bin → dist/bin
  download-sw.js      # Cross-platform: downloads nohost service worker
```

---

## npm Scripts

| Command | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run serve` | Serves `dist/` at `http://localhost:3000` |
| `npm run dev` | Dev server at `http://localhost:1234` with hot reload |
| `npm test` | Runs ESLint |
| `npm run eslint-fix` | Auto-fixes lint errors |

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repo and clone it
2. `npm install`
3. `npm run build` (first time, to get the service worker)
4. `npm run dev` to start hacking
5. Open a pull request with your changes

Ideas for contributions:
- Python REPL panel in the UI
- Git support via [isomorphic-git](https://isomorphic-git.org/)
- More pre-installed Linux packages in the ISO
- Go support via [Yaegi WASM](https://github.com/traefik/yaegi)
- Mobile / touch improvements

---

## Credits

Built on top of [David Humphrey's](https://twitter.com/humphd) [browser-shell](https://github.com/humphd/browser-shell) project.
Hosted on [Cloudflare](https://www.cloudflare.com/).

---

## License

The /PC source code (JS, CSS, HTML) is released under the **MIT License** — see [LICENSE](./LICENSE).

### Third-party binary assets

The files in `src/bin/` are pre-built binary images redistributed under their respective open-source licenses:

| File | Contents | License | Source |
|---|---|---|---|
| `v86-linux.iso` | Linux 4.15.7 kernel + BusyBox | GPLv2 | [humphd/browser-vm](https://github.com/humphd/browser-vm) |
| `seabios.bin` | SeaBIOS firmware | LGPLv3 | [seabios.org](https://www.seabios.org/) |
| `vgabios.bin` | Bochs VGA BIOS | LGPLv2 | [bochs.sourceforge.io](https://bochs.sourceforge.io/) |

The Linux kernel and BusyBox are distributed under the GNU General Public License v2. In accordance with the GPL, the corresponding source code is available at the upstream repositories linked above.
