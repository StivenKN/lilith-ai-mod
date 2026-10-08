// Drives the plugin's Bridge.cs against the real LilithAICompanion.exe, without the game.
// Checks what can only be verified on Windows: process start without a console, UTF-8 both
// ways (Spanish text), the voice messages, clean exit on stdin close, and that a crashed host
// kills the companion.
//
//   BridgeHarness <LilithAICompanion.exe> <mock AI base URL, e.g. http://127.0.0.1:11555/v1>

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using LilithAICompanion;

if (args.Length >= 2 && args[0] == "--host-only")
{
    // Child mode for the orphan test: start the bridge and wait to be killed.
    using var bridge = new Bridge(args[1], (level, message) => Console.WriteLine($"{level}: {message}"), () => Array.Empty<string>());
    bridge.Start();
    Thread.Sleep(Timeout.Infinite);
    return 0;
}

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: BridgeHarness <LilithAICompanion.exe> <mock AI base URL>");
    return 2;
}

var exe = Path.GetFullPath(args[0]);
var dataDir = Path.Combine(Path.GetTempPath(), "lilith-harness-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(dataDir);
File.WriteAllText(Path.Combine(dataDir, "config.json"),
    $$$"""{"provider":{"preset":"custom","baseUrl":"{{{args[1]}}}","model":"mock-lilith","configured":true}}""");
Environment.SetEnvironmentVariable("LILITH_AI_DATA_DIR", dataDir);

var failures = 0;
void Check(bool ok, string what)
{
    Console.WriteLine($"{(ok ? "PASS" : "FAIL")}  {what}");
    if (!ok) failures++;
}

// 1-3: handshake, Spanish round trip, clean shutdown
var inbox = new BlockingCollection<Incoming>();
int? companionPid = null;
var bridgeUnderTest = new Bridge(exe, (level, message) =>
{
    Console.WriteLine($"  [{level}] {message}");
    var match = Regex.Match(message, @"pid (\d+)");
    if (match.Success) companionPid = int.Parse(match.Groups[1].Value);
}, () => new[]
{
    Protocol.State(new GameState(true, false, false, false, false, "es-419", "Ñandú")),
    Protocol.Hello("harness", "harness", "2021.3.45", "harness", Environment.CurrentDirectory, new System.Collections.Generic.Dictionary<string, string> { ["say"] = "ok" }),
});
bridgeUnderTest.Received += message => inbox.Add(message);
bridgeUnderTest.Start();

T? WaitFor<T>(Func<T, bool> predicate, int seconds = 20) where T : Incoming
{
    var deadline = DateTime.UtcNow.AddSeconds(seconds);
    while (DateTime.UtcNow < deadline)
        if (inbox.TryTake(out var message, TimeSpan.FromMilliseconds(200)) && message is T typed && predicate(typed)) return typed;
    return null;
}

var ready = WaitFor<ReadyMessage>(_ => true);
Check(ready is not null, "companion answers hello with ready");
Check(ready?.Strings.Placeholder == "Escríbele a Lilith…", $"ready strings are Spanish and survive UTF-8 decoding ({ready?.Strings.Placeholder})");
Check(ready is { VoiceHotkey: null }, "talking by voice is off until the player turns it on");

bridgeUnderTest.Send(Protocol.Chat("¿Hola, Lilith? Soy ñandú, ¡pingüino!"));
var reply = WaitFor<SayMessage>(say => say.Text != "…");
Check(reply is not null && reply.Text.Any(c => "áéíóúñ¿¡…".Contains(c)), $"a Spanish reply reaches the bubble intact ({reply?.Text.Replace('\n', ' ')})");

// Voice: neither a broken microphone nor a missing speech model ends in silence, and recordings don't pile up.
bridgeUnderTest.Send(Protocol.VoiceError("harness: no microphone"));
var micStatus = WaitFor<ChatStatusMessage>(status => status.Kind == "error");
Check(micStatus?.Text?.Contains("micrófono") == true, $"a microphone failure is explained in Spanish ({micStatus?.Text})");
var recording = Path.Combine(dataDir, "recording.wav");
File.WriteAllBytes(recording, new byte[44]);
bridgeUnderTest.Send(Protocol.Voice(recording));
var sttStatus = WaitFor<ChatStatusMessage>(status => status.Kind == "error");
Check(sttStatus?.Text?.Contains("Voz") == true, $"a recording without speech recognition installed points to the Voice tab ({sttStatus?.Text})");
Check(!File.Exists(recording), "the companion deletes the recording it was sent");

var pid = companionPid;
var stopwatch = Stopwatch.StartNew();
bridgeUnderTest.Dispose();
Check(pid is not null && WaitForExit(pid.Value, 5000), $"closing stdin stops the companion ({stopwatch.ElapsedMilliseconds} ms)");

// 4: a host that dies without cleaning up must not leave the companion running (job object, Windows only)
if (!OperatingSystem.IsWindows())
{
    Console.WriteLine("SKIP  orphan test (job objects are Windows-only)");
    return Finish();
}
var self = Environment.ProcessPath!;
var host = Process.Start(new ProcessStartInfo(self, $"--host-only \"{exe}\"") { RedirectStandardOutput = true, UseShellExecute = false })!;
int? orphanPid = null;
var hostDeadline = DateTime.UtcNow.AddSeconds(15);
while (orphanPid is null && DateTime.UtcNow < hostDeadline)
{
    var line = host.StandardOutput.ReadLine();
    if (line is null) break;
    var match = Regex.Match(line, @"pid (\d+)");
    if (match.Success) orphanPid = int.Parse(match.Groups[1].Value);
}
host.Kill();
Check(orphanPid is not null && WaitForExit(orphanPid.Value, 5000), "killing the host process also kills the companion");

return Finish();

int Finish()
{
    try
    {
        Directory.Delete(dataDir, recursive: true);
    }
    catch (IOException)
    {
        // The log file may still be closing; temp cleanup isn't important.
    }
    Console.WriteLine(failures == 0 ? "All bridge checks passed." : $"{failures} check(s) failed.");
    return failures == 0 ? 0 : 1;
}

static bool WaitForExit(int pid, int milliseconds)
{
    try
    {
        return Process.GetProcessById(pid).WaitForExit(milliseconds);
    }
    catch (ArgumentException)
    {
        return true; // already gone
    }
}
