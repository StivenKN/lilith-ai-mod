using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace LilithAICompanion;

/// <summary>
/// Runs LilithAICompanion.exe as a child process and exchanges JSON lines over its stdin/stdout.
/// - The child lives in a kill-on-close job object, so it can never outlive the game.
/// - stdin/stdout are UTF-8 without BOM (Spanish text must not go through the OEM code page).
/// - stderr is drained continuously (a full pipe would block the child).
/// - Crashes restart after 1 s, 5 s, 15 s; then <see cref="Failed"/> explains why.
/// No BepInEx or Unity types here, so the CI harness can exercise this file on plain .NET.
/// </summary>
internal sealed class Bridge : IDisposable
{
    private static readonly TimeSpan[] RestartDelays = { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15) };
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);
    /// <summary>Exit code meaning "incompatible versions, don't restart me".</summary>
    private const int ExitIncompatible = 2;

    private readonly string _exePath;
    private readonly Action<string, string> _log;
    private readonly Func<IEnumerable<string>> _handshake;
    private readonly object _gate = new();
    private readonly IntPtr _job;
    private Process? _process;
    private StreamWriter? _stdin;
    private DateTime _startedAt;
    private int _crashes;
    private string _lastError = "";
    private Timer? _restartTimer; // kept in a field: an unreferenced Timer can be collected before it fires
    private volatile bool _disposed;

    /// <summary>A message from the companion (raised on a background thread).</summary>
    public event Action<Incoming>? Received;

    /// <summary>The companion can't run; the argument is a short technical reason (raised on a background thread).</summary>
    public event Action<BridgeFailure, string>? Failed;

    /// <param name="exePath">Path to LilithAICompanion.exe.</param>
    /// <param name="log">(level, message) sink.</param>
    /// <param name="handshake">Lines sent each time the companion (re)starts: state then hello.</param>
    public Bridge(string exePath, Action<string, string> log, Func<IEnumerable<string>> handshake)
    {
        _exePath = exePath;
        _log = log;
        _handshake = handshake;
        _job = Native.CreateKillOnCloseJob();
        if (_job == IntPtr.Zero) _log("warn", "Could not create a job object; the companion may outlive a game crash");
    }

    public bool Connected { get; private set; }

    public void Start() => new Thread(Launch) { IsBackground = true, Name = "LilithAI bridge" }.Start();

    /// <summary>Sends one protocol line. Safe from any thread; dropped if the companion isn't running.</summary>
    public void Send(string json)
    {
        lock (_gate)
        {
            if (_stdin is null) return;
            try
            {
                _stdin.Write(json);
                _stdin.Write('\n');
                _stdin.Flush();
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
            {
                // The process is exiting; OnExited handles the restart.
            }
        }
    }

    private void Launch()
    {
        if (_disposed) return;
        if (!File.Exists(_exePath))
        {
            Failed?.Invoke(BridgeFailure.Missing, $"{_exePath} not found (removed by antivirus?)");
            return;
        }

        try
        {
            var info = new ProcessStartInfo(_exePath, "--bridge")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardInputEncoding = Utf8,
                StandardOutputEncoding = Utf8,
                StandardErrorEncoding = Utf8,
                WorkingDirectory = Path.GetDirectoryName(_exePath) ?? Environment.CurrentDirectory,
            };
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.Exited += (_, _) => OnExited(process);
            process.ErrorDataReceived += (_, args) =>
            {
                if (string.IsNullOrWhiteSpace(args.Data)) return;
                _lastError = args.Data;
                _log("warn", $"companion stderr: {args.Data}");
            };
            process.Start();
            if (!Native.AssignToJob(_job, process.Handle)) _log("warn", "Could not add the companion to the job object");
            process.BeginErrorReadLine();

            lock (_gate)
            {
                _process = process;
                _stdin = process.StandardInput;
                _stdin.AutoFlush = false;
                _startedAt = DateTime.UtcNow;
                Connected = true;
            }
            _log("info", $"companion started (pid {process.Id})");
            new Thread(() => ReadLoop(process)) { IsBackground = true, Name = "LilithAI bridge reader" }.Start();
            foreach (var line in _handshake()) Send(line);
        }
        catch (Exception error)
        {
            _lastError = error.Message;
            _log("error", $"could not start the companion: {error}");
            ScheduleRestart();
        }
    }

    private void ReadLoop(Process process)
    {
        try
        {
            string? line;
            while ((line = process.StandardOutput.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                var message = Protocol.Parse(line);
                if (message is null)
                {
                    _log("warn", $"unrecognized line from companion: {Truncate(line, 200)}");
                    continue;
                }
                try
                {
                    Received?.Invoke(message);
                }
                catch (Exception error)
                {
                    _log("error", $"error handling {message.GetType().Name}: {error}");
                }
            }
        }
        catch (Exception error) when (!_disposed)
        {
            _log("warn", $"companion output closed: {error.Message}");
        }
    }

    private void OnExited(Process process)
    {
        int code;
        try
        {
            code = process.ExitCode;
        }
        catch (InvalidOperationException)
        {
            code = -1;
        }
        lock (_gate)
        {
            if (!ReferenceEquals(_process, process)) return;
            _stdin = null;
            _process = null;
            Connected = false;
        }
        if (_disposed) return;

        _log("warn", $"companion exited with code {code}");
        if (code == ExitIncompatible)
        {
            Failed?.Invoke(BridgeFailure.Incompatible, "The game plugin and LilithAICompanion.exe are different versions");
            return;
        }
        // A run that lasted a while was healthy: start counting crashes again.
        if (DateTime.UtcNow - _startedAt > TimeSpan.FromMinutes(2)) _crashes = 0;
        ScheduleRestart();
    }

    private void ScheduleRestart()
    {
        if (_disposed) return;
        if (_crashes >= RestartDelays.Length)
        {
            Failed?.Invoke(BridgeFailure.Crashed, string.IsNullOrEmpty(_lastError) ? "it stopped several times in a row" : _lastError);
            return;
        }
        var delay = RestartDelays[_crashes++];
        _log("info", $"restarting the companion in {delay.TotalSeconds:0} s (attempt {_crashes})");
        _restartTimer?.Dispose();
        _restartTimer = new Timer(_ => Launch(), null, delay, Timeout.InfiniteTimeSpan);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _restartTimer?.Dispose();
        Process? process;
        lock (_gate)
        {
            process = _process;
            try
            {
                _stdin?.Close(); // EOF: the companion saves and exits on its own
            }
            catch (Exception)
            {
                // Already gone.
            }
            _stdin = null;
        }
        try
        {
            if (process is not null && !process.WaitForExit(3000)) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // Best effort: the job object kills it anyway when the game exits.
        }
        if (_job != IntPtr.Zero) Native.CloseHandle(_job);
    }

    private static string Truncate(string text, int max) => text.Length <= max ? text : text[..max] + "…";
}

internal enum BridgeFailure
{
    /// <summary>LilithAICompanion.exe is missing (often quarantined by antivirus).</summary>
    Missing,
    /// <summary>It keeps crashing.</summary>
    Crashed,
    /// <summary>Plugin and exe speak different protocol versions.</summary>
    Incompatible,
}
