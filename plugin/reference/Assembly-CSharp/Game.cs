// Stand-in for the game's Assembly-CSharp interop assembly. Every member here is one the plugin
// calls (see plugin/src/GameApi.cs), with the shape the community mods use in game builds
// 24273498+. Il2CppInterop exposes IL2CPP fields as properties, so they are properties here too.
// If the real game differs, only the affected capability turns off, with the reason logged.
using System;

public class DialogueManager : UnityEngine.MonoBehaviour
{
    public DialogueManager(IntPtr pointer) : base(pointer) { }
    public static DialogueManager instance { get => throw null; set => throw null; }
    public bool IsBusyOrAwaitingResponse => throw null;
    public bool IsBusy => throw null;
    public bool ForceSay(string text, string emotion, float seconds) => throw null;
}

public class CharacterController : UnityEngine.MonoBehaviour
{
    public CharacterController(IntPtr pointer) : base(pointer) { }
    public static CharacterController s_activeInstance { get => throw null; set => throw null; }
    public bool IsIdle => throw null;
    public bool IsSleep => throw null;
    public bool IsInteracting => throw null;
    public bool IsDrag => throw null;
    public static bool TryGetCharacterDesktopPoint(out int x, out int y) => throw null;
}

public class GameSetting : Il2CppSystem.Object
{
    public GameSetting(IntPtr pointer) : base(pointer) { }
    public static string Language { get => throw null; set => throw null; }
}

public class Archive : Il2CppSystem.Object
{
    public Archive(IntPtr pointer) : base(pointer) { }
    public static Archive Instance { get => throw null; set => throw null; }
    public string playerName { get => throw null; set => throw null; }
}

public class ISystemTray : Il2CppSystem.Object
{
    public ISystemTray(IntPtr pointer) : base(pointer) { }
    public void AddSeparator() => throw null;
    public void AddItem(string label, Il2CppSystem.Action callback) => throw null;
}

public class ShowSystemTray : UnityEngine.MonoBehaviour
{
    public ShowSystemTray(IntPtr pointer) : base(pointer) { }
    public static ShowSystemTray instance { get => throw null; set => throw null; }
    public bool initialized { get => throw null; set => throw null; }
    public ISystemTray tray { get => throw null; set => throw null; }
}
