using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace LilithAICompanion;

// Bridge protocol (JSON lines over the companion's stdin/stdout). Mirrors companion/src/protocol.ts.
// Startup order: send `state`, then `hello`; the companion answers `ready`.

internal sealed record HotkeySpec(string Key, bool Ctrl, bool Alt, bool Shift)
{
    public static readonly HotkeySpec Default = new("F7", false, false, false);
    public override string ToString() =>
        string.Join(" + ", new[] { Ctrl ? "Ctrl" : null, Alt ? "Alt" : null, Shift ? "Shift" : null, Key }.Where(part => part is not null));
}

internal sealed record UiStrings(string Placeholder, string Thinking, string Send, string Settings, string TrayTalk, string TraySettings)
{
    public static UiStrings Fallback(bool spanish) => spanish
        ? new("Escríbele a Lilith…", "Lilith está pensando…", "Enviar", "Configuración", "Hablar con Lilith", "Configuración de Lilith AI")
        : new("Message Lilith…", "Lilith is thinking…", "Send", "Settings", "Talk to Lilith", "Lilith AI settings");
}

internal sealed record GameState(bool Idle, bool Sleep, bool Busy, bool Interacting, bool Drag, string LangRaw, string PlayerName);

internal abstract record Incoming;
internal sealed record ReadyMessage(int V, string Version, string DashboardUrl, HotkeySpec Hotkey, UiStrings Strings) : Incoming;
internal sealed record SayMessage(string Id, string Text, string Emotion, float Seconds) : Incoming;
internal sealed record ChatStatusMessage(string Kind, string? Text) : Incoming;
internal sealed record YieldFocusMessage : Incoming;

internal static class Protocol
{
    public const int Version = 1;

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Keep ñ, á, ¿ readable in the stream (the companion decodes UTF-8 either way).
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static string Serialize(object message) => JsonSerializer.Serialize(message, Options);

    public static string State(GameState state) => Serialize(new
    {
        type = "state",
        idle = state.Idle,
        sleep = state.Sleep,
        busy = state.Busy,
        interacting = state.Interacting,
        drag = state.Drag,
        langRaw = state.LangRaw,
        playerName = state.PlayerName,
    });

    public static string Hello(string pluginVersion, string gameVersion, string unityVersion, string bepinexVersion, string gameDir, IReadOnlyDictionary<string, string> caps) =>
        Serialize(new { type = "hello", v = Version, pluginVersion, gameVersion, unityVersion, bepinexVersion, gameDir, caps });

    public static string Chat(string text) => Serialize(new { type = "chat", text });
    public static string Action(string name) => Serialize(new { type = "action", name });
    public static string Result(string id, bool ok, string? error) => Serialize(new { type = "result", id, ok, error });
    public static string Log(string level, string msg) => Serialize(new { type = "log", level, msg });

    /// <summary>Parses a companion message; returns null for unknown or malformed lines.</summary>
    public static Incoming? Parse(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "ready":
                {
                    var hotkey = root.GetProperty("hotkey");
                    var strings = root.GetProperty("strings");
                    return new ReadyMessage(
                        root.GetProperty("v").GetInt32(),
                        root.GetProperty("version").GetString() ?? "",
                        root.GetProperty("dashboardUrl").GetString() ?? "",
                        new HotkeySpec(
                            hotkey.GetProperty("key").GetString() ?? "F7",
                            hotkey.GetProperty("ctrl").GetBoolean(),
                            hotkey.GetProperty("alt").GetBoolean(),
                            hotkey.GetProperty("shift").GetBoolean()),
                        new UiStrings(
                            strings.GetProperty("placeholder").GetString() ?? "",
                            strings.GetProperty("thinking").GetString() ?? "",
                            strings.GetProperty("send").GetString() ?? "",
                            strings.GetProperty("settings").GetString() ?? "",
                            strings.GetProperty("trayTalk").GetString() ?? "",
                            strings.GetProperty("traySettings").GetString() ?? ""));
                }
                case "say":
                    return new SayMessage(
                        root.GetProperty("id").GetString() ?? "",
                        root.GetProperty("text").GetString() ?? "",
                        root.GetProperty("emotion").GetString() ?? "neutral",
                        root.GetProperty("seconds").GetSingle());
                case "chatStatus":
                    return new ChatStatusMessage(
                        root.GetProperty("kind").GetString() ?? "idle",
                        root.TryGetProperty("text", out var text) ? text.GetString() : null);
                case "yieldFocus":
                    return new YieldFocusMessage();
                default:
                    return null;
            }
        }
        catch (Exception)
        {
            return null;
        }
    }
}
