using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;

namespace LilithAICompanion;

/// <summary>
/// The only place that touches the game's own types (Assembly-CSharp). Everything the mod uses
/// was proven in-game by earlier community mods; nothing is patched, only called.
///
/// Game updates rename things. To survive that, every call lives in its own NoInlining method
/// (a missing member then fails only that method, which the caller catches), and <see cref="Probe"/>
/// checks each capability up front so the dashboard can say exactly what stopped working.
/// Call everything here on Unity's main thread.
/// </summary>
internal static class GameApi
{
    public const string Ok = "ok";
    private static readonly Dictionary<string, string> Caps = new();
    private static bool _busyFallback;

    public static IReadOnlyDictionary<string, string> Capabilities => Caps;
    public static bool Has(string capability) => Caps.TryGetValue(capability, out var status) && status == Ok;

    /// <summary>True once the game's dialogue system exists (it doesn't during the first frames).</summary>
    public static bool GameLoaded()
    {
        try
        {
            return DialogueManagerExists();
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Checks every capability. Safe to call again (e.g. after the game finishes loading).</summary>
    public static void Probe()
    {
        Caps["say"] = Check(() =>
            HasMethod(typeof(DialogueManager), "ForceSay", typeof(string), typeof(string), typeof(float))
                ? (DialogueManagerExists() ? null : "DialogueManager not loaded")
                : "DialogueManager.ForceSay(string, string, float) not found");

        Caps["busy"] = Check(() =>
        {
            try
            {
                _ = BusyPrimary();
                _busyFallback = false;
            }
            catch (Exception)
            {
                _ = BusyFallback();
                _busyFallback = true;
            }
            return null;
        });

        Caps["state"] = Check(() =>
        {
            _ = ReadState();
            return null;
        });
        Caps["position"] = Check(() =>
        {
            _ = ReadPosition();
            return null;
        });
        Caps["language"] = Check(() =>
        {
            _ = ReadLanguage();
            return null;
        });
        Caps["playerName"] = Check(() =>
        {
            _ = ReadPlayerName();
            return null;
        });
    }

    private static string Check(Func<string?> probe)
    {
        try
        {
            return probe() ?? Ok;
        }
        catch (Exception error)
        {
            return Describe(error);
        }
    }

    /// <summary>Short, log-friendly reason for a failed game call.</summary>
    public static string Describe(Exception error)
    {
        var root = error is TargetInvocationException { InnerException: { } inner } ? inner : error;
        return root switch
        {
            MissingMemberException or TypeLoadException => $"not in this game version ({root.Message})",
            NullReferenceException => "game object not available",
            _ => $"{root.GetType().Name}: {root.Message}",
        };
    }

    // ── Public operations (each wraps one NoInlining call) ─────────────────

    /// <summary>Shows text in Lilith's speech bubble. Returns null on success, or the reason it failed.</summary>
    public static string? Say(string text, string emotion, float seconds)
    {
        try
        {
            return ForceSay(text, emotion, seconds) ? null : "ForceSay returned false";
        }
        catch (Exception error)
        {
            return Describe(error);
        }
    }

    public static bool IsBusy()
    {
        if (!Has("busy")) return false;
        try
        {
            return _busyFallback ? BusyFallback() : BusyPrimary();
        }
        catch (Exception)
        {
            return false;
        }
    }

    public static GameState SampleState()
    {
        var language = Safe(ReadLanguage, "");
        var player = Safe(ReadPlayerName, "");
        var (idle, sleep, interacting, drag) = Has("state") ? Safe(ReadState, (true, false, false, false)) : (true, false, false, false);
        return new GameState(idle, sleep, IsBusy(), interacting, drag, language, player);
    }

    /// <summary>Lilith's position in desktop pixels, if the game can tell.</summary>
    public static (int X, int Y)? Position() => Has("position") ? Safe(ReadPosition, null) : null;

    public static string GameVersion() => Safe(() => UnityEngine.Application.version, "unknown");
    public static string UnityVersion() => Safe(() => UnityEngine.Application.unityVersion, "unknown");

    private static T Safe<T>(Func<T> read, T fallback)
    {
        try
        {
            return read();
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    // ── The actual game calls ─────────────────────────────────────────────
    // Keep each one tiny and NoInlining: if a member disappears, only this method fails to compile.

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool DialogueManagerExists() => DialogueManager.instance != null;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool ForceSay(string text, string emotion, float seconds)
    {
        var manager = DialogueManager.instance ?? throw new NullReferenceException("DialogueManager.instance");
        return manager.ForceSay(text, emotion, seconds);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool BusyPrimary() => DialogueManager.instance?.IsBusyOrAwaitingResponse ?? false;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool BusyFallback() => DialogueManager.instance?.IsBusy ?? false;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (bool Idle, bool Sleep, bool Interacting, bool Drag) ReadState()
    {
        var character = global::CharacterController.s_activeInstance;
        if (character == null) return (true, false, false, false);
        return (character.IsIdle, character.IsSleep, character.IsInteracting, character.IsDrag);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (int X, int Y)? ReadPosition() =>
        global::CharacterController.TryGetCharacterDesktopPoint(out var x, out var y) ? (x, y) : null;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string ReadLanguage() => GameSetting.Language ?? "";

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string ReadPlayerName() => Archive.Instance?.playerName ?? "";

    private static bool HasMethod(Type type, string name, params Type[] parameters) =>
        type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Any(method => method.Name == name && method.GetParameters().Select(p => p.ParameterType).SequenceEqual(parameters));
}

/// <summary>
/// Adds "Talk to Lilith" and "Lilith AI settings" to the game's tray menu. The game rebuilds that
/// menu now and then, so the item count is watched and the items re-added when they vanish.
/// Entirely optional: any failure just marks the "tray" capability as unavailable.
/// </summary>
internal static class TrayMenu
{
    // Converted delegates must stay referenced, or the GC frees them while native code holds them.
    private static Il2CppSystem.Action? _talk;
    private static Il2CppSystem.Action? _settings;
    private static int? _countAfterAdd;
    private static string _labels = "";

    /// <summary>Adds the items if needed. Returns "ok", "waiting", or a failure reason.</summary>
    public static string Ensure(UiStrings strings, Action onTalk, Action onSettings)
    {
        try
        {
            var labels = strings.TrayTalk + "|" + strings.TraySettings;
            var count = MenuItemCount();
            var present = _countAfterAdd.HasValue && (count is null || count >= _countAfterAdd);
            if (present && labels == _labels) return GameApi.Ok;
            if (!TrayReady()) return "waiting for the tray menu";

            // Callbacks arrive on a native thread; the handlers only post work elsewhere.
            _talk ??= DelegateSupport.ConvertDelegate<Il2CppSystem.Action>(onTalk) ?? throw new InvalidOperationException("could not convert the tray callback");
            _settings ??= DelegateSupport.ConvertDelegate<Il2CppSystem.Action>(onSettings) ?? throw new InvalidOperationException("could not convert the tray callback");
            AddItems(strings.TrayTalk, strings.TraySettings, _talk, _settings);
            _labels = labels;
            _countAfterAdd = MenuItemCount();
            return GameApi.Ok;
        }
        catch (Exception error)
        {
            return GameApi.Describe(error);
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool TrayReady() => ShowSystemTray.instance != null && ShowSystemTray.instance.initialized && ShowSystemTray.instance.tray != null;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void AddItems(string talk, string settings, Il2CppSystem.Action onTalk, Il2CppSystem.Action onSettings)
    {
        var tray = ShowSystemTray.instance.tray;
        tray.AddSeparator();
        tray.AddItem(talk, onTalk);
        tray.AddItem(settings, onSettings);
    }

    /// <summary>
    /// Number of entries in the native menu (WindowsSystemTrayAdapter._tray._menuActions.Count),
    /// read by reflection because those internals aren't stable. Null if unknown.
    /// </summary>
    private static int? MenuItemCount()
    {
        try
        {
            object? tray = TrayObject();
            if (tray is not Il2CppObjectBase wrapper) return null;
            var adapterType = AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType("WindowsSystemTrayAdapter", false))
                .FirstOrDefault(type => type is not null);
            if (adapterType is null) return null;
            var adapter = typeof(Il2CppObjectBase).GetMethod(nameof(Il2CppObjectBase.TryCast))!.MakeGenericMethod(adapterType).Invoke(wrapper, null);
            var inner = adapter?.GetType().GetProperty("_tray")?.GetValue(adapter);
            var actions = inner?.GetType().GetProperty("_menuActions")?.GetValue(inner);
            return actions?.GetType().GetProperty("Count")?.GetValue(actions) as int?;
        }
        catch (Exception)
        {
            return null;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static object? TrayObject() => ShowSystemTray.instance?.tray;
}
