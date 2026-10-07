using System;
using System.Runtime.InteropServices;

namespace LilithAICompanion;

/// <summary>Win32 declarations used by the bridge (job object) and the chat window.</summary>
internal static class Native
{
    // ── Job object: the companion dies with the game, even if the game crashes ──

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr handle);

    /// <summary>Creates a job whose processes are killed when its last handle closes (i.e. when the game exits).</summary>
    internal static IntPtr CreateKillOnCloseJob()
    {
        if (!OperatingSystem.IsWindows()) return IntPtr.Zero; // lets the CI harness run elsewhere too
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JobExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<JobExtendedLimitInformation>()))
        {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    internal static bool AssignToJob(IntPtr job, IntPtr process) => job != IntPtr.Zero && AssignProcessToJobObject(job, process);

    // ── Windows, messages, input ──

    internal delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct WndClassEx
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MonitorInfo
    {
        public uint cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Point
    {
        public int X, Y;
    }

    internal const uint WM_DESTROY = 0x0002;
    internal const uint WM_ACTIVATE = 0x0006;
    internal const uint WM_SETFONT = 0x0030;
    internal const uint WM_CLOSE = 0x0010;
    internal const uint WM_KEYDOWN = 0x0100;
    internal const uint WM_CHAR = 0x0102;
    internal const uint WM_COMMAND = 0x0111;
    internal const uint WM_HOTKEY = 0x0312;
    internal const uint WM_QUIT = 0x0012;
    internal const uint WM_APP = 0x8000;
    internal const uint EM_SETCUEBANNER = 0x1501;
    internal const uint EM_SETSEL = 0x00B1;
    internal const int VK_RETURN = 0x0D;
    internal const int VK_ESCAPE = 0x1B;
    internal const int WA_INACTIVE = 0;
    internal const int GWLP_WNDPROC = -4;
    internal const int SW_HIDE = 0;
    internal const int SW_SHOW = 5;
    internal const uint WS_POPUP = 0x80000000;
    internal const uint WS_CHILD = 0x40000000;
    internal const uint WS_VISIBLE = 0x10000000;
    internal const uint WS_BORDER = 0x00800000;
    internal const uint WS_TABSTOP = 0x00010000;
    internal const uint WS_EX_TOPMOST = 0x00000008;
    internal const uint WS_EX_TOOLWINDOW = 0x00000080;
    internal const uint ES_AUTOHSCROLL = 0x0080;
    internal const uint SS_ENDELLIPSIS = 0x4000;
    internal const uint SS_NOPREFIX = 0x0080;
    internal const uint BS_PUSHBUTTON = 0x0000;
    internal const uint MOD_ALT = 0x0001;
    internal const uint MOD_CONTROL = 0x0002;
    internal const uint MOD_SHIFT = 0x0004;
    internal const uint MOD_NOREPEAT = 0x4000;
    internal const uint MONITOR_DEFAULTTONEAREST = 2;
    internal const int GCS_COMPSTR = 0x0008;
    internal const int COLOR_WINDOW = 5;
    internal static readonly IntPtr DpiAwarenessPerMonitorV2 = new(-4);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern ushort RegisterClassExW(ref WndClassEx wndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateWindowExW(uint exStyle, string className, string? windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    internal static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern IntPtr CallWindowProcW(IntPtr previous, IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    internal static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    internal static extern int GetMessageW(out Msg msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    internal static extern bool TranslateMessage(ref Msg msg);

    [DllImport("user32.dll")]
    internal static extern IntPtr DispatchMessageW(ref Msg msg);

    [DllImport("user32.dll")]
    internal static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    internal static extern void PostQuitMessage(int exitCode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool SetWindowTextW(IntPtr hwnd, string text);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextW(IntPtr hwnd, [Out] char[] buffer, int maxCount);

    [DllImport("user32.dll")]
    internal static extern int GetWindowTextLengthW(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern IntPtr SetFocus(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);

    [DllImport("user32.dll")]
    internal static extern bool UnregisterHotKey(IntPtr hwnd, int id);

    [DllImport("user32.dll")]
    internal static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    internal static extern IntPtr LoadCursorW(IntPtr instance, IntPtr cursor);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetSysColorBrush(int index);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr GetModuleHandleW(string? moduleName);

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeOut, uint charSet, uint outPrecision, uint clipPrecision, uint quality, uint pitchAndFamily, string faceName);

    [DllImport("gdi32.dll")]
    internal static extern bool DeleteObject(IntPtr handle);

    [DllImport("imm32.dll")]
    internal static extern IntPtr ImmGetContext(IntPtr hwnd);

    [DllImport("imm32.dll")]
    internal static extern bool ImmReleaseContext(IntPtr hwnd, IntPtr context);

    [DllImport("imm32.dll", EntryPoint = "ImmGetCompositionStringW")]
    internal static extern int ImmGetCompositionString(IntPtr context, int index, IntPtr buffer, int length);

    internal static int LowWord(IntPtr value) => (int)((long)value & 0xFFFF);
    internal static int HighWord(IntPtr value) => (int)(((long)value >> 16) & 0xFFFF);
}
