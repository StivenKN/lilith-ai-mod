using System;
using System.IO;
using System.Text;
using static LilithAICompanion.Native;

namespace LilithAICompanion;

/// <summary>
/// The player's microphone, through Windows' classic MCI "waveaudio" device: nothing extra to ship,
/// and it records straight to a 16 kHz mono 16-bit WAV, the format speech recognition wants.
/// The companion transcribes the file and deletes it.
/// MCI ties an open device to the thread that opened it: call everything from one thread (the chat window's).
/// </summary>
internal sealed class Microphone
{
    private const string Alias = "lilithmic";

    public bool Recording { get; private set; }

    /// <summary>Starts recording. Returns null, or why it couldn't (no microphone, access denied...).</summary>
    public string? Start()
    {
        if (Recording) return null;
        Close(); // a session that failed halfway
        var error = Mci($"open new type waveaudio alias {Alias}")
            ?? Mci($"set {Alias} time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2")
            ?? Mci($"record {Alias}");
        if (error is not null)
        {
            Close();
            return error;
        }
        Recording = true;
        return null;
    }

    /// <summary>Stops and saves the recording to a temporary WAV file.</summary>
    public (string? Path, string? Error) Stop()
    {
        if (!Recording) return (null, "not recording");
        Recording = false;
        try
        {
            var folder = Path.Combine(Path.GetTempPath(), "LilithAICompanion");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, $"voice-{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}.wav");
            var error = Mci($"stop {Alias}") ?? Mci($"save {Alias} \"{path}\"");
            return error is null ? (path, null) : (null, error);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return (null, error.Message);
        }
        finally
        {
            Close();
        }
    }

    /// <summary>Discards a recording in progress.</summary>
    public void Cancel()
    {
        Recording = false;
        Close();
    }

    private static void Close() => mciSendStringW($"close {Alias}", null, 0, IntPtr.Zero);

    /// <summary>Runs one MCI command; null on success, else a readable reason.</summary>
    private static string? Mci(string command)
    {
        var code = mciSendStringW(command, null, 0, IntPtr.Zero);
        if (code == 0) return null;
        var verb = command.Split(' ')[0];
        var text = new StringBuilder(256);
        return mciGetErrorStringW(code, text, text.Capacity) ? $"{verb}: {text}" : $"{verb}: MCI error {code}";
    }
}

/// <summary>
/// Plays Lilith's spoken replies (WAV files the companion writes, already at the chosen volume).
/// PlaySound is asynchronous and built into Windows; a new sound replaces the one playing.
/// It doesn't touch the game's own audio, which Unity plays separately.
/// </summary>
internal static class Speaker
{
    /// <summary>Starts playing; null, or why it couldn't.</summary>
    public static string? Play(string path) =>
        PlaySoundW(path, IntPtr.Zero, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) ? null : $"PlaySound could not play {path}";

    public static void Stop() => PlaySoundW(null, IntPtr.Zero, 0);
}
