'use strict';

const filesystem = require('./filesystem');
const { V86Starter } = require('v86');
const { defaultEmulatorOptions } = require('./config');
const cache = require('./cache');

// ── Boot loader helpers ──────────────────────────────────────────────────────

// Timed messages shown while the VM boots cold for the first time.
const COLD_BOOT_MESSAGES = [
  { at:  0, status: 'Starting Linux…',          hint: 'Setting up the virtual machine' },
  { at:  6, status: 'Loading kernel…',           hint: 'Booting Linux 4.15.7 inside your browser' },
  { at: 18, status: 'Initialising filesystem…',  hint: 'Mounting your persistent workspace at /mnt' },
  { at: 35, status: 'Still booting…',            hint: 'First visit takes 1–2 minutes — the OS is being cached for next time' },
  { at: 65, status: 'Almost there…',             hint: 'Hang tight, the shell prompt will appear shortly' },
  { at: 95, status: 'Any moment now…',           hint: 'The VM is saving its state so future loads are instant' },
];

let _loaderTimer = null;

function startLoaderMessages(isWarm) {
  const statusEl = document.getElementById('boot-status');
  const hintEl   = document.getElementById('boot-hint');
  if (!statusEl || !hintEl) return;

  if (isWarm) {
    statusEl.textContent = 'Restoring from cache…';
    hintEl.textContent   = 'Loading your previous session — this only takes a moment';
    return;
  }

  let idx = 0;
  const startTime = Date.now();

  function tick() {
    const elapsed = (Date.now() - startTime) / 1000;
    // Advance to the latest message whose `at` threshold has been passed
    while (idx < COLD_BOOT_MESSAGES.length - 1 && elapsed >= COLD_BOOT_MESSAGES[idx + 1].at) {
      idx++;
    }
    const msg = COLD_BOOT_MESSAGES[idx];
    statusEl.textContent = msg.status;
    hintEl.textContent   = msg.hint;
  }

  tick();
  _loaderTimer = setInterval(tick, 1000);
}

function hideLoader() {
  if (_loaderTimer) {
    clearInterval(_loaderTimer);
    _loaderTimer = null;
  }
  const el = document.getElementById('boot-loader');
  if (el) el.classList.add('hidden');
}

// Shell prompts used during boot sequencing.
const bootPrompt = '/ # ';    // initial prompt at root
const prompt     = '/mnt # '; // prompt after auto-cd to /mnt

const getVMStartOptions = () => {
  const options = Object.create(defaultEmulatorOptions);

  // Pass the filesystem into the vm
  options.filesystem = filesystem;

  return options;
};

let emulator = null;

// ── Python REPL state ─────────────────────────────────────────────────────────

let pythonReplActive = false;
let replInputLine    = '';
let replLineBuffer   = [];   // accumulates lines for multi-line blocks
let _replPushFn      = null; // cached Python proxy for _repl_push()

// Activate the interactive Python REPL.  Sets up Pyodide stdout/stderr,
// installs a tiny CommandCompiler-based push function in Python, and prints
// the opening banner + first prompt.
async function startPythonRepl(term) {
  const pyodide = window.pyodide;
  if (!pyodide) {
    term.writeln(`\r${ANSI_YELLOW}[/PC] Python is still loading — wait for the "Python ✓" badge and try again.${ANSI_RESET}`);
    return;
  }

  // Redirect output so print() / tracebacks go to the xterm terminal.
  // Replace bare \n with \r\n so xterm renders newlines correctly.
  pyodide.setStdout({ batched: text => term.write(text.replace(/\n/g, '\r\n')) });
  pyodide.setStderr({ batched: text => term.write(`${ANSI_RED}${text.replace(/\n/g, '\r\n')}${ANSI_RESET}`) });

  // Install a reusable _repl_push(source) helper in Pyodide.
  // Uses codeop.CommandCompiler (same mechanism as Python's own REPL):
  //   returns 'incomplete' when more input is needed (e.g. inside a def/for)
  //   returns 'complete'   after successful execution
  //   returns 'error'      on SyntaxError / runtime exception (traceback printed to stderr)
  //   returns 'exit'       when the user calls exit() / quit()
  await pyodide.runPythonAsync(`
from codeop import CommandCompiler as _CC
import traceback as _tb

_compile      = _CC()
_repl_globals = {'__name__': '__console__', '__doc__': None}

def _repl_push(source):
    try:
        code_obj = _compile(source, '<stdin>', 'single')
        if code_obj is None:
            return 'incomplete'
        exec(code_obj, _repl_globals)
        return 'complete'
    except SystemExit:
        return 'exit'
    except BaseException:
        _tb.print_exc()
        return 'error'
`);

  if (_replPushFn) _replPushFn.destroy();
  _replPushFn = pyodide.globals.get('_repl_push');

  pythonReplActive = true;
  replInputLine    = '';
  replLineBuffer   = [];

  term.writeln(`\r${ANSI_YELLOW}Python ${pyodide.version} (Pyodide / WebAssembly)${ANSI_RESET}`);
  term.writeln(`\r${ANSI_DIM}Type "exit()" or press Ctrl+D to return to the shell.${ANSI_RESET}`);
  term.write('\r>>> ');
}

// Exit REPL mode and restore the shell prompt.
function exitPythonRepl(term, vmCwd) {
  pythonReplActive = false;
  replInputLine    = '';
  replLineBuffer   = [];
  if (_replPushFn) { _replPushFn.destroy(); _replPushFn = null; }
  term.write('\r\n' + vmCwd + ' # ');
}

// Handle a single key press while the REPL is active.
async function handleReplKey(key, term, vmCwd) {
  if (key === '\r') { // ── Enter ────────────────────────────────────────────
    const line = replInputLine;
    replInputLine = '';
    term.write('\r\n');

    replLineBuffer.push(line);
    const source = replLineBuffer.join('\n');

    let status = 'error';
    try {
      status = _replPushFn(source);
    } catch (e) {
      console.error('[REPL] push error', e);
    }

    if (status === 'incomplete') {
      term.write('... ');
    } else if (status === 'exit') {
      replLineBuffer = [];
      exitPythonRepl(term, vmCwd);
    } else {
      // 'complete' or 'error' — either way show the next prompt
      replLineBuffer = [];
      term.write('>>> ');
    }

  } else if (key === '\x04') { // ── Ctrl+D (EOF) ─────────────────────────────
    if (replInputLine === '' && replLineBuffer.length === 0) {
      term.write('\r\n');
      exitPythonRepl(term, vmCwd);
    }

  } else if (key === '\x03') { // ── Ctrl+C (interrupt) ───────────────────────
    replInputLine  = '';
    replLineBuffer = [];
    term.write('\r\nKeyboardInterrupt\r\n>>> ');

  } else if (key === '\x7f') { // ── Backspace ─────────────────────────────────
    if (replInputLine.length > 0) {
      replInputLine = replInputLine.slice(0, -1);
      term.write('\b \b');
    }

  } else if (key.length === 1) { // ── Printable character ───────────────────
    replInputLine += key;
    term.write(key);
  }
  // All other keys (arrow keys, function keys, etc.) are silently ignored.
}

module.exports.boot = async term => {
  if (emulator) {
    return;
  }  

  const hasCachedVM = await cache.hasState();
  if (hasCachedVM) {
    try {
      await warmBoot(term);
    } catch(err) {
      console.log('Warm boot failed:', err.message);
      await coldBoot(term);
    }
  } else {
    await coldBoot(term);
  }

  // Reduce CPU/battery use when not in focus
  // TODO: we might want to add UI to disable this later
  term.on('focus', resume);
  term.on('blur', suspend);
};

// Pause the running VM
const suspend = module.exports.suspend = () => {
  updatePowerUI(false);

  if (!(emulator && emulator.is_running())) {
    return;
  }

  emulator.stop();
};

// Restart the paused VM
const resume = module.exports.resume = () => {
  updatePowerUI(true);

  if (!(emulator && !emulator.is_running())) {
    return;
  }

  emulator.run();
};

// Toggle play/pause power buttons so only 1 is active
const updatePowerUI = (isPlaying) => {
  const termPlay = document.querySelector('#term-play');
  const termPause = document.querySelector('#term-pause');

  if(isPlaying) {
    termPlay.classList.add('inactive');
    termPause.classList.remove('inactive');
  } else {
    termPlay.classList.remove('inactive');
    termPause.classList.add('inactive');
  }
};

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ANSI_YELLOW = '\x1b[33m';
const ANSI_CYAN   = '\x1b[36m';
const ANSI_RED    = '\x1b[31m';
const ANSI_DIM    = '\x1b[2m';
const ANSI_RESET  = '\x1b[0m';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Python interception helpers ───────────────────────────────────────────────

function isPythonCommand(line) {
  return /^python[23]?(\s|$)/.test(line);
}

// Convert a VM filesystem path to a Filer filesystem path.
//
// Inside the VM, /mnt is the 9P mount of the Filer filesystem whose own root is /.
//   VM /mnt/hello.py  →  Filer /hello.py
//   VM /mnt/proj/a.py →  Filer /proj/a.py
//
// vmCwd is the shell's current working directory (e.g. "/mnt" or "/mnt/projects"),
// used to resolve relative paths.
function vmPathToFilerPath(vmPath, vmCwd) {
  // Make the VM path absolute using the tracked CWD
  let absVmPath;
  if (vmPath.startsWith('/')) {
    absVmPath = vmPath;
  } else {
    const base = (vmCwd || '/mnt').replace(/\/$/, '');
    absVmPath = base + '/' + vmPath;
  }

  // Strip the /mnt prefix to get the Filer-internal path
  if (absVmPath === '/mnt') return '/';
  if (absVmPath.startsWith('/mnt/')) return absVmPath.slice(4); // '/mnt/foo' → '/foo'

  // Path is outside /mnt — Filer cannot access it
  throw new Error(`'${vmPath}' is outside /mnt. Only files in /mnt are accessible to Python.`);
}

function readFileFromFs(filePath) {
  return new Promise((resolve, reject) => {
    filesystem.fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) reject(new Error(`Cannot open '${filePath}': ${err.message}`));
      else resolve(data);
    });
  });
}

// Parse a python command line into { mode, code/filePath, sysArgv }
function parsePythonCommand(line) {
  // Strip the interpreter name (python / python2 / python3)
  const rest = line.replace(/^python[23]?\s*/, '').trim();

  if (!rest) {
    return { mode: 'repl' };
  }

  if (rest.startsWith('-c ') || rest.startsWith('-c\t')) {
    let code = rest.slice(2).trim();
    // Strip surrounding quotes the user typed
    if ((code.startsWith('"') && code.endsWith('"')) ||
        (code.startsWith("'") && code.endsWith("'"))) {
      code = code.slice(1, -1);
    }
    return { mode: 'code', code };
  }

  // Everything else: treat first non-flag token as the script filename
  const parts = rest.split(/\s+/);
  let filePath = null;
  const sysArgv = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) {
      filePath = parts[i];
      sysArgv.push(...parts.slice(i));
      break;
    }
  }
  // Return the raw path as typed; vmPathToFilerPath resolves it with CWD later
  if (filePath) return { mode: 'file', filePath, sysArgv };
  return { mode: 'unknown', rest };
}

async function runPythonInTerminal(line, term, vmCwd) {
  const pyodide = window.pyodide;

  if (!pyodide) {
    term.writeln(`\r${ANSI_YELLOW}[/PC] Python is still loading — wait for the "Python ✓" badge and try again.${ANSI_RESET}`);
    return;
  }

  const parsed = parsePythonCommand(line);

  if (parsed.mode === 'repl') {
    await startPythonRepl(term);
    return;
  }

  // Redirect Python stdout / stderr to the terminal
  pyodide.setStdout({ batched: text => term.writeln('\r' + text) });
  pyodide.setStderr({ batched: text => term.writeln(`\r${ANSI_RED}${text}${ANSI_RESET}`) });

  let code;
  try {
    if (parsed.mode === 'code') {
      code = parsed.code;
    } else if (parsed.mode === 'file') {
      const filerPath = vmPathToFilerPath(parsed.filePath, vmCwd);
      code = await readFileFromFs(filerPath);
      // Set sys.argv so scripts can read their own filename and any extra args
      const argv = parsed.sysArgv && parsed.sysArgv.length ? parsed.sysArgv : [parsed.filePath];
      pyodide.runPython(`import sys; sys.argv = ${JSON.stringify(argv)}`);
    } else {
      term.writeln(`\r${ANSI_RED}[/PC] Could not parse: ${line}${ANSI_RESET}`);
      return;
    }

    await pyodide.runPythonAsync(code);

  } catch (err) {
    // Format Python tracebacks nicely — they are already multi-line
    const msg = (err.message || String(err)).trimEnd();
    msg.split('\n').forEach(l => term.writeln(`\r${ANSI_RED}${l}${ANSI_RESET}`));
  }
}

// ── Terminal wiring ───────────────────────────────────────────────────────────

// Read the full text of the line the cursor is currently on from xterm's buffer.
// This is the ground truth — it includes tab-completions, pasted text, and
// history recalled with arrow keys, none of which appear in raw key events.
function getCurrentTerminalLine(term) {
  try {
    const y = term.buffer.viewportY + term.buffer.cursorY;
    const line = term.buffer.getLine(y);
    return line ? line.translateToString(true) : '';
  } catch (_) {
    return '';
  }
}

// Wire up event handlers, print shell prompt (which we've eaten), and focus term.
const startTerminal = (emulator, term) => {
  hideLoader();
  term.reset();
  term.writeln(`Linux 4.15.7  |  Python ${ANSI_CYAN}✓${ANSI_RESET} via Pyodide  |  Files persist in ${ANSI_CYAN}/mnt${ANSI_RESET}`);
  term.writeln(`${ANSI_DIM}Try: python  (REPL)  |  python -c "print('hi')"  |  python script.py${ANSI_RESET}`);

  let inputLine   = '';
  let suppressOut = true;   // suppress serial until auto-cd completes
  let vmCwd       = '/mnt'; // current working directory, updated on each Enter

  // Input handler — intercepts python commands, passes everything else to the VM
  term.on('key', async (key) => {
    // ── REPL mode: all keys go to the Python interpreter, not the VM ──────────
    if (pythonReplActive) {
      await handleReplKey(key, term, vmCwd);
      return;
    }

    if (key === '\r') { // Enter
      // Read the actual terminal display line — ground truth that includes
      // tab-completions, history (arrow keys), paste, etc.
      const termLine = getCurrentTerminalLine(term);

      // The line looks like: "/mnt # python hello.py"
      // Extract CWD and command from the displayed prompt + input
      const promptMatch = termLine.match(/^(\/[^\s]*)\s+#\s+(.*)/);
      const command = promptMatch
        ? promptMatch[2].trim()
        : inputLine.trim(); // fallback if buffer read fails

      if (promptMatch) vmCwd = promptMatch[1]; // keep CWD in sync

      inputLine = '';

      if (isPythonCommand(command)) {
        term.write('\r\n');
        suppressOut = true;
        emulator.serial0_send('\x15'); // Ctrl+U clears shell's buffer silently
        await sleep(80);
        suppressOut = false;
        await runPythonInTerminal(command, term, vmCwd);
        // Don't overwrite the REPL's own '>>> ' prompt when entering REPL mode
        if (!pythonReplActive) {
          term.write('\r\n' + vmCwd + ' # ');
        }
      } else {
        emulator.serial0_send(key);
      }

    } else if (key === '\x7f') { // Backspace
      inputLine = inputLine.slice(0, -1);
      emulator.serial0_send(key);

    } else if (key === '\x03') { // Ctrl+C
      inputLine = '';
      emulator.serial0_send(key);

    } else {
      if (key.length === 1) inputLine += key;
      emulator.serial0_send(key);
    }
  });

  // Output handler — write serial chars to terminal (suppressed during Ctrl+U)
  emulator.add_listener('serial0-output-char', char => {
    if (suppressOut) return;
    term.write(char);
  });

  // Auto-cd to /mnt so files are always saved in the persistent filesystem.
  // Suppress serial output while the command runs, then reveal the prompt.
  // This also handles warm-booted states that were saved before this change
  // (which would restore at '/ #' instead of '/mnt #').
  // Sync the kernel's terminal size with xterm so full-screen apps like nano
  // use the full window instead of the kernel's default 80×24.
  emulator.serial0_send(`stty rows ${term.rows} cols ${term.cols}; cd /mnt\r`);
  setTimeout(() => {
    suppressOut = false;
    term.write(prompt);
  }, 300);

  updatePowerUI(true);
};

// Power up VM, saving state when boot completes.
const coldBoot = async term => {
  startLoaderMessages(false);
  const options = getVMStartOptions();
  emulator = new V86Starter(options);

  await storeInitialStateOnBoot(emulator, term);
  return emulator;
};

// Restore VM from saved state
const warmBoot = async term => {
  startLoaderMessages(true);
  // Add saved state URL for vm
  const options = getVMStartOptions();

  return cache.getState()
    .then(response => response.arrayBuffer())
    .then(arrayBuffer =>
      URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/octet-stream' } )))
    .then(url => {
      options.initial_state = { url };
      emulator = new V86Starter(options);
      startTerminal(emulator, term);
    });
};

// Wait until we get our shell prompt (other characters are noise on the serial port at startup)
// At the same time, print all boot messages to the screen, and clear when booted.
const waitForPrompt = async (emulator, term) =>
  new Promise(resolve => {
    let serialBuffer = '';
    let screenBuffer = [];
    let currentRow;

    function handleScreenCharData(data) {
      const row = data[0];
      const col = data[1];
      const char = data[2];

      // Flush the buffer and advance to next line
      if(row !== currentRow) {
        currentRow = row;
        term.writeln(screenBuffer.join(''));
        screenBuffer = [];
      }

      screenBuffer[col] = String.fromCharCode(char);
    }
  
    let cdSent = false;

    function handleSerialCharData(char) {
      serialBuffer += char;

      // Step 1: initial root prompt — silently cd to /mnt
      if (!cdSent && serialBuffer.endsWith(bootPrompt)) {
        cdSent = true;
        emulator.serial0_send('cd /mnt\r');
        return;
      }

      // Step 2: /mnt prompt confirms the cd succeeded — boot is complete
      if (cdSent && serialBuffer.endsWith(prompt)) {
        emulator.remove_listener('screen-put-char', handleScreenCharData);
        emulator.remove_listener('serial0-output-char', handleSerialCharData);
        term.clear();
        resolve();
      }
    }

    // Start listening for data over the serial and screen buses.
    emulator.add_listener('screen-put-char', handleScreenCharData);
    emulator.add_listener('serial0-output-char', handleSerialCharData);
  });

// Notify the running Linux kernel of an xterm resize so full-screen apps
// (nano, vim, etc.) immediately adapt to the new dimensions.
module.exports.resize = term => {
  if (emulator && emulator.is_running()) {
    emulator.serial0_send(`stty rows ${term.rows} cols ${term.cols}\r`);
  }
};

const storeInitialStateOnBoot = async (emulator, term) => {
  // Wait for the prompt to come up, then start term and save the VM state
  await waitForPrompt(emulator, term);
  startTerminal(emulator, term);
  emulator.save_state(cache.saveState);
  console.log('Saved VM cpu/memory state to Cache Storage');
};
