import { fileURLToPath } from 'node:url';

import { createPackageManager } from './packages.ts';

const prefix = process.env.PREFIX;
const stateDir = process.env.PI_ANDROID_STATE;
const usage = 'Usage: pi-pkg list | pi-pkg plan PACKAGE | pi-pkg install PACKAGE --yes';
const [command, name, ...flags] = process.argv.slice(2);

try {
  if (command === '--help') {
    console.log(usage);
  } else {
    if (!prefix || !stateDir)
      throw new Error('pi-pkg requires the Android app PREFIX and private state.');
    const manager = createPackageManager({
      prefix,
      stateDir,
      baselineFile: fileURLToPath(new URL('./termux-baseline.json', import.meta.url)),
    });
    if (command === 'list' && !name && !flags.length) {
      for (const pkg of (await manager.installed()).values()) {
        console.log(`${pkg.package}\t${pkg.version}\t${pkg.bundled ? 'bundled' : 'added'}`);
      }
    } else if (command === 'plan' && name && !flags.length) {
      const result = await manager.plan(name);
      if (!result.packages.length) console.log(`${name} is already installed.`);
      for (const pkg of result.packages)
        console.log(`${pkg.Package}\t${pkg.Version}\t${pkg.Size} bytes`);
    } else if (command === 'install' && name) {
      if (flags.length !== 1 || flags[0] !== '--yes') {
        throw new Error(
          'Review pi-pkg plan PACKAGE first. Installation requires explicit --yes; use existing authorization or ask the owner.',
        );
      }
      await manager.install(name, console.log);
    } else {
      throw new Error(usage);
    }
  }
} catch (error) {
  // This CLI has no access token input/output. Never echo arbitrary raw fetch errors/URLs.
  console.error(
    error instanceof Error && !(error instanceof TypeError)
      ? error.message
      : 'Package operation failed.',
  );
  process.exitCode = 1;
}
