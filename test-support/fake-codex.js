import { chmodSync, copyFileSync, linkSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET_TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

export function prepareFakeCodex(root) {
  const triple = TARGET_TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) return null;
  const shimDir = join(root, 'npm-prefix');
  mkdirSync(shimDir, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(shimDir, 'codex.cmd'), '@echo off\r\n');
  } else {
    const shim = join(shimDir, 'codex');
    writeFileSync(shim, '#!/bin/sh\n');
    chmodSync(shim, 0o755);
  }
  const packageRoot = join(shimDir, 'node_modules', '@openai', 'codex');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.144.3' }));
  const platformPackageDir = join(packageRoot, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
  const vendorBinDir = join(platformPackageDir, 'vendor', triple, 'bin');
  mkdirSync(vendorBinDir, { recursive: true });
  writeFileSync(
    join(platformPackageDir, 'package.json'),
    JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }),
  );
  const vendorBinary = join(vendorBinDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  try {
    linkSync(process.execPath, vendorBinary);
  } catch {
    copyFileSync(process.execPath, vendorBinary);
  }
  if (process.platform !== 'win32') chmodSync(vendorBinary, 0o755);
  return { shimDir, packageRoot: realpathSync(packageRoot), vendorBinary };
}

export function pathOnlyEnv(env, shimDir) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'path') delete next[key];
  }
  next.PATH = shimDir;
  return next;
}
