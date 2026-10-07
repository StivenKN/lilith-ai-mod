using System;
using UnityEngine;

namespace LilithAICompanion;

/// <summary>
/// Injected MonoBehaviour whose only job is to give the plugin a per-frame tick on Unity's main
/// thread, where all game calls must happen. Kept minimal: IL2CPP-injected types only support
/// simple method signatures.
/// </summary>
public sealed class Runtime : MonoBehaviour
{
    public Runtime(IntPtr pointer) : base(pointer)
    {
    }

    private void Update()
    {
        try
        {
            Plugin.Instance?.Tick();
        }
        catch (Exception error)
        {
            Plugin.Instance?.Write("error", $"tick failed: {error}");
        }
    }
}
