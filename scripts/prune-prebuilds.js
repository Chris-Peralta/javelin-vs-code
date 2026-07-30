#!/usr/bin/env node
// node-hid ships prebuilt native bindings for every platform/arch in one npm
// package. Before packaging a platform-specific vsix, strip the prebuilds
// that don't match the target so that vsix stays small and only carries the
// binary it actually needs.
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/prune-prebuilds.js <vsce-target>');
  process.exit(1);
}

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-hid', 'prebuilds');
if (!fs.existsSync(prebuildsDir)) {
  console.log(`No prebuilds directory at ${prebuildsDir}, nothing to prune.`);
  process.exit(0);
}

let kept = 0;
let removed = 0;
for (const entry of fs.readdirSync(prebuildsDir)) {
  if (entry.endsWith(target)) {
    kept++;
    continue;
  }
  fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true });
  removed++;
}

if (kept === 0) {
  console.error(`No node-hid prebuilds match target "${target}". Aborting so the build doesn't silently ship a broken vsix.`);
  process.exit(1);
}

console.log(`Pruned node-hid prebuilds for target "${target}": kept ${kept}, removed ${removed}.`);
