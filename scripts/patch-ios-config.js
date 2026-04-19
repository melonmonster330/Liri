#!/usr/bin/env node
// Patches ios/App/App/capacitor.config.json after `cap sync` to add local SPM plugin classes.
// Capacitor CLI only scans npm-installed plugins for packageClassList — local plugins in
// CapApp-SPM are never discovered, so we must add them manually here.
const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, '../ios/App/App/capacitor.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const localPlugins = ['NativeAudioPlugin', 'ShazamPlugin'];
const existing = config.packageClassList || [];
const merged = [...new Set([...existing, ...localPlugins])];
config.packageClassList = merged;

fs.writeFileSync(configPath, JSON.stringify(config, null, '\t'));
console.log(`✔ Patched packageClassList: ${merged.join(', ')}`);
