import { spawn } from 'child_process';

declare const require: any;

export function launchChrome(
  exePath: string = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: string = 'C:\\pw-chrome-profile',
  remotePort: number = 9222
): number | null {
  const args = [`--remote-debugging-port=${remotePort}`, `--user-data-dir=${userDataDir}`];

  try {
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    // let the child run independently of the parent
    child.unref();
    return child.pid || null;
  } catch (err) {
    console.error('Failed to launch Chrome:', err);
    return null;
  }
}

// CLI usage: node or ts-node
if (require.main === module) {
  const argv = process.argv.slice(2);
  const exe = argv[0] || undefined;
  const profile = argv[1] || undefined;
  const port = argv[2] ? Number(argv[2]) : undefined;

  const pid = launchChrome(exe, profile, port || 9222);
  if (pid) console.log(`Launched Chrome (pid=${pid})`);
  else console.error('Launch failed');
}
