using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;

namespace LilithAICompanion;

/// <summary>
/// Entry point. Keeps the game side thin: it launches LilithAICompanion.exe (which holds all the
/// AI logic, settings and the dashboard), forwards chat from the popup, shows replies in Lilith's
/// speech bubble, leaves her cards in the game's note inbox, and reports her state. Each startup stage is isolated so one failure can't
/// stop the others, and the game's main thread is never blocked on I/O.
/// </summary>
[BepInPlugin(Guid, "Lilith AI Companion", Version)]
public sealed class Plugin : BasePlugin
{
    public const string Guid = "lilith.ai.companion";
    public const string Version = "0.1.0";

    internal static Plugin? Instance { get; private set; }

    private readonly ConcurrentQueue<Action> _mainThread = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Dictionary<string, string> _localCaps = new() { ["hotkey"] = "waiting for settings", ["chatWindow"] = "not started", ["tray"] = "waiting for settings" };
    private Bridge? _bridge;
    private ChatWindow? _chat;
    private UiStrings _strings = UiStrings.Fallback(spanish: false);
    private volatile bool _ready;
    private bool _probed;
    private bool _capsDirty;
    private double _nextSample, _nextTray, _lastStateSentAt = double.NegativeInfinity;
    private GameState? _lastState;
    private volatile string _stateLine = "";
    private volatile string _helloLine = "";

    public override void Load()
    {
        Instance = this;
        Log.LogInfo($"Lilith AI Companion {Version} loading");
        Stage("main-thread runtime", () => AddComponent<Runtime>());
        Stage("chat window", StartChatWindow);
        Stage("companion", StartBridge);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Shutdown();
    }

    public override bool Unload()
    {
        Shutdown();
        return true;
    }

    private void Stage(string name, Action start)
    {
        try
        {
            start();
        }
        catch (Exception error)
        {
            Write("error", $"Could not start {name}; the rest of the mod keeps running. {error}");
        }
    }

    private void Shutdown()
    {
        _chat?.Dispose();
        _bridge?.Dispose();
        _chat = null;
        _bridge = null;
    }

    // ── Startup ───────────────────────────────────────────────────────────

    private void StartChatWindow()
    {
        _chat = new ChatWindow(_strings);
        _chat.Submitted += text =>
        {
            if (_bridge is { Connected: true }) _bridge.Send(Protocol.Chat(text));
            else _chat.SetStatus(LocalText.NotRunning(IsSpanish()));
        };
        _chat.SettingsRequested += () => _bridge?.Send(Protocol.Action("dashboard"));
        _chat.HotkeyStatusChanged += status => _mainThread.Enqueue(() => SetLocalCap("hotkey", status));
        _chat.Start();
        SetLocalCap("chatWindow", _chat.Status);
    }

    private void StartBridge()
    {
        var folder = Path.GetDirectoryName(typeof(Plugin).Assembly.Location) ?? Paths.PluginPath;
        _bridge = new Bridge(Path.Combine(folder, "LilithAICompanion.exe"), Write, Handshake);
        _bridge.Received += OnCompanionMessage;
        _bridge.Failed += (failure, detail) => _mainThread.Enqueue(() => ReportFailure(failure, detail));
        _bridge.Start();
    }

    /// <summary>Sent to the companion on every (re)start, once the game state is known.</summary>
    private IEnumerable<string> Handshake() => _probed ? new[] { _stateLine, _helloLine } : Array.Empty<string>();

    // ── Main thread (called every frame by Runtime) ──────────────────────────

    internal void Tick()
    {
        while (_mainThread.TryDequeue(out var work))
        {
            try
            {
                work();
            }
            catch (Exception error)
            {
                Write("error", $"main-thread task failed: {error}");
            }
        }

        var now = _clock.Elapsed.TotalSeconds;
        if (!_probed)
        {
            // The dialogue system appears a few frames after start; don't wait forever for it.
            if (!GameApi.GameLoaded() && now < 30) return;
            GameApi.Probe();
            _probed = true;
            foreach (var (name, status) in GameApi.Capabilities.Concat(_localCaps))
                Write(status == GameApi.Ok ? "info" : "warn", $"capability {name}: {status}");
            SendStateAndHello(GameApi.SampleState());
        }

        if (now >= _nextSample)
        {
            _nextSample = now + 0.5;
            var state = GameApi.SampleState();
            _chat?.SetAnchor(GameApi.Position());
            if (_capsDirty) SendStateAndHello(state);
            else if (state != _lastState || now - _lastStateSentAt > 30) SendState(state);
        }

        if (_ready && now >= _nextTray)
        {
            _nextTray = now + 5;
            SetLocalCap("tray", TrayMenu.Ensure(_strings, () => _chat?.Show(), () => _bridge?.Send(Protocol.Action("dashboard"))));
        }
    }

    private void SendState(GameState state)
    {
        _lastState = state;
        _lastStateSentAt = _clock.Elapsed.TotalSeconds;
        _stateLine = Protocol.State(state);
        _bridge?.Send(_stateLine);
    }

    private void SendStateAndHello(GameState state)
    {
        _capsDirty = false;
        var caps = GameApi.Capabilities.Concat(_localCaps).ToDictionary(pair => pair.Key, pair => pair.Value);
        _helloLine = Protocol.Hello(Version, GameApi.GameVersion(), GameApi.UnityVersion(), BepInExVersion(), Paths.GameRootPath, caps);
        SendState(state);
        _bridge?.Send(_helloLine);
    }

    /// <summary>Capabilities owned by the plugin itself; a change is re-announced to the companion.</summary>
    private void SetLocalCap(string name, string status)
    {
        if (_localCaps.TryGetValue(name, out var previous) && previous == status) return;
        _localCaps[name] = status;
        if (_probed) _capsDirty = true;
        Write(status == GameApi.Ok ? "info" : "warn", $"capability {name}: {status}");
    }

    // ── Companion messages (arrive on the bridge's reader thread) ─────────────

    private void OnCompanionMessage(Incoming message)
    {
        switch (message)
        {
            case ReadyMessage ready:
                _strings = ready.Strings;
                _chat?.SetStrings(ready.Strings);
                _chat?.SetHotkey(ready.Hotkey);
                _ready = true;
                break;
            case SayMessage say:
                _mainThread.Enqueue(() =>
                {
                    var error = GameApi.Say(say.Text, say.Emotion, say.Seconds);
                    if (error is not null) Write("warn", $"could not show text in the bubble: {error}");
                    _bridge?.Send(Protocol.Result(say.Id, error is null, error));
                });
                break;
            case CardMessage card:
                _mainThread.Enqueue(() =>
                {
                    var error = GameApi.LeaveCard(card.Text);
                    if (error is not null) Write("warn", $"could not leave a card in the inbox: {error}");
                    _bridge?.Send(Protocol.Result(card.Id, error is null, error));
                });
                break;
            case ChatStatusMessage status when status.Text is not null:
                _chat?.SetStatus(status.Text);
                break;
            case YieldFocusMessage:
                _chat?.YieldFocus();
                break;
        }
    }

    private void ReportFailure(BridgeFailure failure, string detail)
    {
        Write("error", $"companion unavailable ({failure}): {detail}");
        var text = LocalText.Failure(failure, IsSpanish());
        _chat?.SetStatus(text);
        if (GameApi.Has("say")) GameApi.Say(text, "sad", 12f);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /// <summary>Logs to BepInEx and mirrors the line into the companion's unified log.</summary>
    internal void Write(string level, string message)
    {
        switch (level)
        {
            case "error": Log.LogError(message); break;
            case "warn": Log.LogWarning(message); break;
            case "debug": Log.LogDebug(message); break;
            default: Log.LogInfo(message); break;
        }
        if (_bridge is { Connected: true }) _bridge.Send(Protocol.Log(level, message));
    }

    private bool IsSpanish()
    {
        var language = _lastState?.LangRaw ?? "";
        return language.StartsWith("es", StringComparison.OrdinalIgnoreCase) || language.Contains("spanish", StringComparison.OrdinalIgnoreCase);
    }

    private static string BepInExVersion() =>
        typeof(BasePlugin).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(BasePlugin).Assembly.GetName().Version?.ToString()
        ?? "unknown";
}

/// <summary>The few messages the plugin must show on its own, when the companion can't.</summary>
internal static class LocalText
{
    public static string NotRunning(bool spanish) => spanish
        ? "Lilith AI todavía no está listo. Espera unos segundos e inténtalo de nuevo."
        : "Lilith AI isn't ready yet. Wait a few seconds and try again.";

    public static string Failure(BridgeFailure failure, bool spanish) => (failure, spanish) switch
    {
        (BridgeFailure.Missing, true) => "Lilith AI: falta LilithAICompanion.exe (¿lo borró el antivirus?). Vuelve a instalar el mod.",
        (BridgeFailure.Missing, false) => "Lilith AI: LilithAICompanion.exe is missing (removed by antivirus?). Reinstall the mod.",
        (BridgeFailure.Incompatible, true) => "Lilith AI: el plugin y la app son de versiones distintas. Vuelve a instalar el mod.",
        (BridgeFailure.Incompatible, false) => "Lilith AI: the plugin and the app are different versions. Reinstall the mod.",
        (_, true) => "Lilith AI dejó de funcionar varias veces. Revisa BepInEx\\LogOutput.log.",
        _ => "Lilith AI stopped several times. Check BepInEx\\LogOutput.log.",
    };
}
