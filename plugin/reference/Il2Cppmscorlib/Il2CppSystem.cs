// Stand-in for the game's Il2Cppmscorlib interop assembly: only what the plugin references.
using System;
using Il2CppInterop.Runtime.InteropTypes;

namespace Il2CppSystem
{
    public class Object : Il2CppObjectBase
    {
        public Object(IntPtr pointer) : base(pointer) { }
    }

    public class Delegate : Object
    {
        public Delegate(IntPtr pointer) : base(pointer) { }
    }

    public class MulticastDelegate : Delegate
    {
        public MulticastDelegate(IntPtr pointer) : base(pointer) { }
    }

    public sealed class Action : MulticastDelegate
    {
        public Action(IntPtr pointer) : base(pointer) { }
    }
}
