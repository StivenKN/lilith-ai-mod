// Stand-in for the game's UnityEngine.CoreModule interop assembly: only what the plugin references.
using System;

namespace UnityEngine
{
    public class Object : Il2CppSystem.Object
    {
        public Object(IntPtr pointer) : base(pointer) { }
    }

    public class Component : Object
    {
        public Component(IntPtr pointer) : base(pointer) { }
    }

    public class Behaviour : Component
    {
        public Behaviour(IntPtr pointer) : base(pointer) { }
    }

    public class MonoBehaviour : Behaviour
    {
        public MonoBehaviour(IntPtr pointer) : base(pointer) { }
    }

    public sealed class Application : Object
    {
        public Application(IntPtr pointer) : base(pointer) { }
        public static string version => throw null;
        public static string unityVersion => throw null;
    }
}
