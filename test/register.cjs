"use strict";

// Loaded via `--require` so `import * as vscode from "vscode"` resolves to our mock
// instead of failing (there's no real `vscode` package outside the extension host).
const Module = require("module");
const vscodeMock = require("./vscodeMock.cjs");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalLoad.apply(this, arguments);
};
