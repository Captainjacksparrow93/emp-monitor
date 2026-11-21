// Keep-alive / tamper resistance. When enabled the agent is relaunched if an employee ends it
// from Task Manager (Windows) or Activity Monitor (macOS):
//   - Windows: a Scheduled Task runs the agent at logon and re-checks every minute. The agent's
//     single-instance lock makes the extra launches exit, so a killed agent is back within ~1 min.
//   - macOS: a per-user LaunchAgent with KeepAlive=true, which launchd relaunches within ~1 second.
// Both run in the logged-in user's GUI session (needed for screenshots). This does NOT hide the
// process from the task list, and an administrator can always remove it (uninstall, or delete the
// task / LaunchAgent). For protection against a standard user who knows where to look, deploy the
// task / LaunchAgent at system scope through MDM / an elevated installer (see the README).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const log = (...a) => console.log(new Date().toISOString(), '[persistence]', ...a);
// Imported lazily so the pure builders below can be unit-tested without Electron.
const electronApp = async () => (await import('electron')).app;

export const TASK_NAME = 'EmpMonitor Agent';
export const LAUNCH_LABEL = 'com.empmonitor.agent';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Windows Scheduled Task definition: start at logon + every minute, in the interactive user session. */
export function buildWindowsTaskXml(exe) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>EmpMonitor Agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2024-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(exe)}</Command>
    </Exec>
  </Actions>
</Task>`;
}

/** macOS LaunchAgent plist: relaunches the agent whenever it stops. */
export function buildMacPlist(exe, label = LAUNCH_LABEL) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exe)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>`;
}

const macPlistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);

async function installWindows() {
  const xml = buildWindowsTaskXml(process.execPath);
  const file = path.join(os.tmpdir(), `empmon-task-${process.pid}.xml`);
  // schtasks /XML expects UTF-16LE with a BOM.
  await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  try {
    await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
    log('scheduled task installed');
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

async function installMac() {
  const plist = macPlistPath();
  await fsp.mkdir(path.dirname(plist), { recursive: true });
  await fsp.writeFile(plist, buildMacPlist(process.execPath));
  const domain = `gui/${process.getuid()}`;
  // Reload cleanly if it was already loaded.
  await run('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`]).catch(() => {});
  await run('launchctl', ['bootstrap', domain, plist]).catch((e) => log('bootstrap', e.message));
  await run('launchctl', ['enable', `${domain}/${LAUNCH_LABEL}`]).catch(() => {});
  log('launch agent installed');
}

export async function installPersistence() {
  if (!(await electronApp()).isPackaged) return;
  try {
    if (process.platform === 'win32') await installWindows();
    else if (process.platform === 'darwin') await installMac();
  } catch (e) {
    log('install failed:', e.message);
  }
}

/** Remove the keep-alive so the agent can actually stop (used on revoke / uninstall). */
export async function removePersistence() {
  try {
    if (process.platform === 'win32') {
      await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']).catch(() => {});
    } else if (process.platform === 'darwin') {
      await run('launchctl', ['bootout', `gui/${process.getuid()}/${LAUNCH_LABEL}`]).catch(() => {});
      await fsp.rm(macPlistPath(), { force: true }).catch(() => {});
    }
    log('removed');
  } catch (e) {
    log('remove failed:', e.message);
  }
}

let current = null;
/** Install or remove to match `enabled`, only acting on a change. */
export async function ensurePersistence(enabled) {
  if (current === enabled || !(await electronApp()).isPackaged) return;
  current = enabled;
  if (enabled) await installPersistence();
  else await removePersistence();
}

// exported for testing
export const _internal = { macPlistPath, installed: () => fs.existsSync(macPlistPath()) };
