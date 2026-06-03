#!/usr/bin/env node
import { execSync } from 'child_process';

const token = process.env.OVSX_TOKEN;

if (!token) {
  console.error('❌  OVSX_TOKEN environment variable is not set.');
  console.error('    Run: export OVSX_TOKEN="your-token-here"');
  process.exit(1);
}

console.log('Publishing to Open VSX Registry...');
execSync(`ovsx publish -p ${token}`, { stdio: 'inherit' });
