/**
 * Audio Capture — Node.js microphone recording via platform-native tools
 *
 * Records audio by spawning OS-native commands that require no user installs:
 *   - macOS: Swift script using AVAudioRecorder (ships with Xcode CLT)
 *   - Windows: PowerShell script using winmm.dll MCI commands (built-in)
 *   - Linux: arecord (ALSA) → parecord (PulseAudio) → pw-record (PipeWire)
 *
 * Uses stdin as a signal channel: the recorder process prints RECORDING_STARTED
 * to stdout when ready, then blocks on readLine(). To stop, we write "\n" to
 * stdin, the process saves the file and exits.
 *
 * Inspired by claude-unbound/damocles recorder architecture.
 *
 * Owns: child process lifecycle, temp file management, WAV→Float32 conversion.
 * Does not: run transcription (caller handles that via voice-engine).
 *
 * @module host/audio-capture
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, readdirSync, unlinkSync, promises as fsp } from 'node:fs';
import { log } from '../core/log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveRecording {
  process: ChildProcess;
  tempWavPath: string;
  tempScriptPath: string | null;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activeRecording: ActiveRecording | null = null;

/** Guard against concurrent startCapture() calls (double-click race). */
let starting = false;

// ---------------------------------------------------------------------------
// Startup cleanup
// ---------------------------------------------------------------------------

/**
 * Remove orphaned crispy-voice-*.wav files left behind by previous sessions
 * (e.g. crash, force-quit, or stopProcess timeout). Call once at startup.
 */
export function cleanupOrphanedVoiceFiles(): void {
  try {
    const tmp = tmpdir();
    const orphans = readdirSync(tmp).filter(
      (f) => f.startsWith('crispy-voice-') && f.endsWith('.wav'),
    );
    for (const file of orphans) {
      try {
        unlinkSync(join(tmp, file));
      } catch {
        // best-effort — file may be in use by an active recording
      }
    }
    if (orphans.length > 0) {
      log({
        source: 'voice',
        level: 'info',
        summary: `Cleaned up ${orphans.length} orphaned voice temp file(s)`,
      });
    }
  } catch {
    // tmpdir read failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start capturing microphone audio via platform-native tools.
 * Resolves when recording has actually started (RECORDING_STARTED signal).
 *
 * @throws if recording is already in progress or platform unsupported.
 */
export async function startCapture(): Promise<void> {
  if (activeRecording || starting) {
    throw new Error('Recording already in progress');
  }

  starting = true;
  try {
    const tempWavPath = join(tmpdir(), `crispy-voice-${Date.now()}.wav`);

    log({
      source: 'voice',
      level: 'info',
      summary: `Starting host-side audio capture on ${process.platform}...`,
    });

    if (process.platform === 'darwin') {
      await startMacRecording(tempWavPath);
    } else if (process.platform === 'win32') {
      await startWindowsRecording(tempWavPath);
    } else if (process.platform === 'linux') {
      await startLinuxRecording(tempWavPath);
    } else {
      throw new Error(`Voice recording not supported on ${process.platform}`);
    }

    log({
      source: 'voice',
      level: 'info',
      summary: 'Recording started',
    });
  } finally {
    starting = false;
  }
}

/**
 * Stop recording and return captured audio as Float32Array at the recorded sample rate.
 *
 * @returns PCM Float32Array (values in -1..1) plus sample rate.
 * @throws if no recording is active or if stop/read fails.
 */
export async function stopCapture(): Promise<{ pcmFloat32: Float32Array; sampleRate: number }> {
  if (!activeRecording) {
    throw new Error('No recording active — call startCapture() first');
  }

  const { process: proc, tempWavPath, tempScriptPath, startedAt } = activeRecording;
  activeRecording = null;

  try {
    // Signal the recorder to stop by writing to stdin
    await stopProcess(proc);

    const durationMs = Date.now() - startedAt;

    log({
      source: 'voice',
      level: 'info',
      summary: `Recording stopped after ${durationMs}ms, reading ${tempWavPath}...`,
    });

    const wavBuffer = await fsp.readFile(tempWavPath);
    const result = wavToFloat32(wavBuffer);

    log({
      source: 'voice',
      level: 'info',
      summary: `WAV decoded: ${result.pcmFloat32.length} samples, ${result.sampleRate}Hz (${(result.pcmFloat32.length / result.sampleRate).toFixed(1)}s)`,
    });

    return result;
  } catch (err) {
    log({
      source: 'voice',
      level: 'error',
      summary: `Failed to stop/read recording: ${err instanceof Error ? err.message : err}`,
    });
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    // Cleanup temp files — always runs, even if stopProcess times out
    fsp.unlink(tempWavPath).catch(() => {});
    if (tempScriptPath) fsp.unlink(tempScriptPath).catch(() => {});
  }
}

/**
 * Cancel an active recording without returning audio.
 */
export function cancelCapture(): void {
  if (!activeRecording) return;

  const { process: proc, tempWavPath, tempScriptPath } = activeRecording;
  activeRecording = null;

  proc.kill();
  fsp.unlink(tempWavPath).catch(() => {});
  if (tempScriptPath) fsp.unlink(tempScriptPath).catch(() => {});

  log({
    source: 'voice',
    level: 'info',
    summary: 'Recording cancelled',
  });
}

/**
 * Check if a recording is currently active.
 */
export function isCapturing(): boolean {
  return activeRecording !== null;
}

// ---------------------------------------------------------------------------
// Platform-specific recorders
// ---------------------------------------------------------------------------

/**
 * Spawn a recorder process and wait for the RECORDING_STARTED signal.
 * The process writes audio to `tempWavPath` and blocks on stdin.
 */
function spawnRecorder(
  command: string,
  args: string[],
  tempWavPath: string,
  tempScriptPath: string | null = null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let resolved = false;
    let stderrOutput = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output.includes('RECORDING_STARTED') && !resolved) {
        resolved = true;
        activeRecording = { process: proc, tempWavPath, tempScriptPath, startedAt: Date.now() };
        resolve();
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
      const msg = data.toString().trim();
      if (msg) log({ source: 'voice', level: 'warn', summary: `Voice: recorder stderr — ${msg.slice(0, 200)}` });
    });

    proc.on('error', (err) => {
      log({ source: 'voice', level: 'error', summary: `recorder error: ${err.message}` });
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(
          code !== 0
            ? stderrOutput.trim() || `Recording process exited with code ${code}`
            : 'Recording process exited without starting',
        ));
      }
    });

    // Timeout: if RECORDING_STARTED doesn't arrive within 15s, give up
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error('Recording process startup timed out'));
      }
    }, 15_000);
  });
}

/** macOS: Swift script using AVAudioRecorder. */
function startMacRecording(outputPath: string): Promise<void> {
  const swiftScript = `import AVFoundation
import Foundation

let outputPath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: outputPath)
let semaphore = DispatchSemaphore(value: 0)
var micGranted = false
AVCaptureDevice.requestAccess(for: .audio) { granted in
    micGranted = granted
    semaphore.signal()
}
semaphore.wait()
guard micGranted else {
    FileHandle.standardError.write("Microphone access denied. Grant permission in System Settings > Privacy & Security > Microphone.\\n".data(using: .utf8)!)
    exit(1)
}
let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
]
do {
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    guard recorder.record() else {
        FileHandle.standardError.write("Failed to start recording\\n".data(using: .utf8)!)
        exit(1)
    }
    print("RECORDING_STARTED")
    fflush(stdout)
    _ = readLine()
    recorder.stop()
    print("RECORDING_SAVED")
} catch {
    FileHandle.standardError.write("Recording error: \\(error.localizedDescription)\\n".data(using: .utf8)!)
    exit(1)
}`;

  const scriptPath = join(tmpdir(), `crispy-recorder-${Date.now()}.swift`);
  writeFileSync(scriptPath, swiftScript);

  return spawnRecorder('swift', [scriptPath, outputPath], outputPath, scriptPath)
    .catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Swift not found. Install Xcode Command Line Tools: xcode-select --install');
      }
      throw err;
    });
}

/** Windows: PowerShell script using winmm.dll MCI commands. */
function startWindowsRecording(outputPath: string): Promise<void> {
  const psPath = outputPath.replace(/'/g, "''");

  const script = `$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinMM {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(string lpszCommand, StringBuilder lpszReturnString, int cchReturn, IntPtr hwndCallback);
}
"@
$sb = New-Object System.Text.StringBuilder 256
$outFile = '${psPath}'
$r = [WinMM]::mciSendString("open new type waveaudio alias crispyrec", $sb, 256, [IntPtr]::Zero)
if ($r -ne 0) { Write-Error "Failed to open audio device (MCI error $r)"; exit 1 }
$r = [WinMM]::mciSendString("set crispyrec time format milliseconds", $sb, 256, [IntPtr]::Zero)
# Try to pin 16-bit/mono/16kHz for best transcription quality
$fmt = @("set crispyrec bitspersample 16","set crispyrec channels 1","set crispyrec samplespersec 16000")
foreach ($cmd in $fmt) { [WinMM]::mciSendString($cmd, $sb, 256, [IntPtr]::Zero) | Out-Null }
$r = [WinMM]::mciSendString("record crispyrec", $sb, 256, [IntPtr]::Zero)
if ($r -ne 0) {
  # Format pins unsupported by this driver — reopen at device defaults
  [WinMM]::mciSendString("close crispyrec", $sb, 256, [IntPtr]::Zero)
  $r = [WinMM]::mciSendString("open new type waveaudio alias crispyrec", $sb, 256, [IntPtr]::Zero)
  if ($r -ne 0) { Write-Error "Failed to reopen audio device (MCI error $r)"; exit 1 }
  [WinMM]::mciSendString("set crispyrec time format milliseconds", $sb, 256, [IntPtr]::Zero)
  $r = [WinMM]::mciSendString("record crispyrec", $sb, 256, [IntPtr]::Zero)
  if ($r -ne 0) {
    [WinMM]::mciSendString("close crispyrec", $sb, 256, [IntPtr]::Zero)
    Write-Error "Failed to start recording (MCI error $r)"
    exit 1
  }
  [Console]::Error.WriteLine("MCI: format pins unsupported, recording at device defaults")
}
Write-Output "RECORDING_STARTED"
$null = [Console]::In.ReadLine()
[WinMM]::mciSendString("stop crispyrec", $sb, 256, [IntPtr]::Zero)
$saveCmd = 'save crispyrec "' + $outFile + '"'
[WinMM]::mciSendString($saveCmd, $sb, 256, [IntPtr]::Zero)
[WinMM]::mciSendString("close crispyrec", $sb, 256, [IntPtr]::Zero)
Write-Output "RECORDING_SAVED"`;

  return spawnRecorder('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], outputPath);
}

/** Linux: tries arecord (ALSA) → parecord (PulseAudio) → pw-record (PipeWire). */
function startLinuxRecording(outputPath: string): Promise<void> {
  const script = `OUTPUT="$1"
if command -v arecord >/dev/null 2>&1; then
  arecord -f S16_LE -r 16000 -c 1 -t wav -q "$OUTPUT" &
elif command -v parecord >/dev/null 2>&1; then
  parecord --format=s16le --rate=16000 --channels=1 --file-format=wav "$OUTPUT" &
elif command -v pw-record >/dev/null 2>&1; then
  pw-record --format=s16 --rate=16000 --channels=1 "$OUTPUT" &
else
  echo "No audio recorder found. Install one of: alsa-utils (arecord), pulseaudio-utils (parecord), or pipewire (pw-record)." >&2
  exit 1
fi
RECORDER_PID=$!
sleep 0.2
if ! kill -0 $RECORDER_PID 2>/dev/null; then
  echo "Audio recorder failed to start" >&2
  exit 1
fi
trap 'kill -INT $RECORDER_PID 2>/dev/null; wait $RECORDER_PID 2>/dev/null' EXIT
echo "RECORDING_STARTED"
read -r
kill -INT $RECORDER_PID 2>/dev/null
wait $RECORDER_PID 2>/dev/null
trap - EXIT
echo "RECORDING_SAVED"`;

  return spawnRecorder('bash', ['-c', script, '_', outputPath], outputPath);
}

// ---------------------------------------------------------------------------
// WAV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a WAV file buffer into Float32 PCM samples.
 * Supports 16-bit signed and 8-bit unsigned integer PCM.
 */
function wavToFloat32(wav: Buffer): { pcmFloat32: Float32Array; sampleRate: number } {
  // Validate RIFF header
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file');
  }

  // Find fmt chunk
  let offset = 12;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let numChannels = 1;
  let audioFormat = 1; // 1 = PCM integer

  while (offset < wav.length - 8) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      audioFormat = wav.readUInt16LE(offset + 8);
      numChannels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bitsPerSample = wav.readUInt16LE(offset + 22);
    }

    if (chunkId === 'data') {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, wav.length);
      const dataSlice = wav.subarray(dataStart, dataEnd);

      if (audioFormat !== 1) {
        throw new Error(`Unsupported WAV format: ${audioFormat} (expected 1/PCM)`);
      }

      if (bitsPerSample !== 16 && bitsPerSample !== 8) {
        throw new Error(`Unsupported WAV bit depth: ${bitsPerSample} (expected 8 or 16)`);
      }

      const bytesPerSample = bitsPerSample / 8;
      const frameSize = bytesPerSample * numChannels;
      const frameCount = Math.floor(dataSlice.length / frameSize);
      const pcmFloat32 = new Float32Array(frameCount);

      if (bitsPerSample === 16) {
        // 16-bit signed integer PCM → Float32 (-1..1)
        for (let i = 0; i < frameCount; i++) {
          pcmFloat32[i] = dataSlice.readInt16LE(i * frameSize) / 32768;
        }
      } else {
        // 8-bit unsigned integer PCM → Float32 (-1..1); 128 = silence
        for (let i = 0; i < frameCount; i++) {
          pcmFloat32[i] = (dataSlice[i * frameSize] - 128) / 128;
        }
      }

      return { pcmFloat32, sampleRate };
    }

    offset += 8 + chunkSize;
    // Chunks are 2-byte aligned
    if (chunkSize % 2 !== 0) offset++;
  }

  throw new Error('WAV file has no data chunk');
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

/** Signal the recorder process to stop by writing to stdin, wait for exit. */
function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Stop recording timed out'));
    }, 10_000);

    proc.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    // Signal stop via stdin
    proc.stdin?.write('\n');
    proc.stdin?.end();
  });
}
