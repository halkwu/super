import { spawn, execSync } from 'child_process';

declare const require: any;

function getPidListeningOnPort(port: number): number | null {
  try {
    // Run netstat and find the PID for the port in LISTENING state
    const out = execSync('netstat -aon', { encoding: 'utf8' });
    const lines = out.split(/\r?\n/);
    const portToken = `:${port}`;
    for (const line of lines) {
      const ln = line.trim();
      if (!ln) continue;
      // Typical Windows netstat TCP line contains 'TCP    0.0.0.0:9932    0.0.0.0:0    LISTENING    1234'
      if (ln.indexOf(portToken) === -1) continue;
      if (!/LISTEN(ING)?/i.test(ln)) continue;
      const parts = ln.split(/\s+/);
      const pidStr = parts[parts.length - 1];
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) return pid;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

export function launchChrome(
  exePath: string = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: string = 'C:\\pw-chrome-profile',
  remotePort: number = 9222
): number | null {
  // Bind CDP to localhost and add flags to keep instances isolated
  const args = [
    `--remote-debugging-port=${remotePort}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-sync',
    '--disable-background-timer-throttling'
  ];

  try {
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    // let the child run independently of the parent
    child.unref();

    // Wait briefly for Chrome to bind the debug port and return the real listening PID
    const start = Date.now();
    const timeoutMs = 5000;
    let pid: number | null = null;
    while (Date.now() - start < timeoutMs) {
      pid = getPidListeningOnPort(remotePort);
      if (pid) break;
      // small delay
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }

    // Prefer the listening PID (actual Chrome process). Fall back to spawn PID if not found.
    return pid || child.pid || null;
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
