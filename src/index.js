'use strict';

const server = require('./server');
const terminal = require('./terminal');
const pyodide = require('./pyodide-loader');

server.start();
terminal.start();
pyodide.start();
