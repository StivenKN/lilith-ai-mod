using System;
using System.Runtime.InteropServices;
using System.Threading;
using static LilithAICompanion.Native;

namespace LilithAICompanion;

/// <summary>
/// The chat input: a small native window on its own thread, shown with a global hotkey.
/// Native instead of in-game UI on purpose: the game's overlay window is click-through and rarely
/// focused, which makes Unity text fields unreliable. A real Win32 edit box gets keyboard focus
/// properly (RegisterHotKey grants it), and handles dead keys, AltGr and IMEs, so á, ñ, ¿ and
/// Japanese input all just work.
/// Public methods are thread-safe: they post messages to the window thread.
/// </summary>
internal sealed class ChatWindow : IDisposable
{
    private const string ClassName = "LilithAICompanionChat";
    private const int HotkeyId = 1;
    private const int IdEdit = 1, IdSend = 2, IdSettings = 3;
    private const uint WmShow = WM_APP + 1, WmStatus = WM_APP + 2, WmHotkeyChanged = WM_APP + 3, WmStrings = WM_APP + 4;
    private const uint EmLimitText = 0x00C5;

    // Delegates handed to native code must stay referenced for the window's lifetime.
    private static WndProc? s_windowProc;
    private static WndProc? s_editProc;

    private readonly object _gate = new();
    private readonly ManualResetEventSlim _created = new();
    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hwnd, _edit, _send, _settings, _status, _font, _symbolFont, _originalEditProc, _previousForeground;
    private float _scale = 1f;
    private UiStrings _strings;
    private HotkeySpec? _hotkey;
    private string _statusText = "";
    private (int X, int Y)? _anchor;

    public ChatWindow(UiStrings strings) => _strings = strings;

    /// <summary>The user sent a message (raised on the window thread).</summary>
    public event Action<string>? Submitted;
    /// <summary>The settings button was pressed (raised on the window thread).</summary>
    public event Action? SettingsRequested;
    /// <summary>Hotkey registration result: "ok" or why it failed (raised on the window thread).</summary>
    public event Action<string>? HotkeyStatusChanged;

    public string Status { get; private set; } = "not started";

    public void Start()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "LilithAI chat window" };
        _thread.Start();
        _created.Wait(TimeSpan.FromSeconds(5));
    }

    /// <summary>Where Lilith is on the desktop (pixels); the window opens next to her.</summary>
    public void SetAnchor((int X, int Y)? anchor)
    {
        lock (_gate) _anchor = anchor;
    }

    public void SetStatus(string text)
    {
        lock (_gate) _statusText = text;
        PostMessageW(_hwnd, WmStatus, IntPtr.Zero, IntPtr.Zero);
    }

    public void SetStrings(UiStrings strings)
    {
        lock (_gate) _strings = strings;
        PostMessageW(_hwnd, WmStrings, IntPtr.Zero, IntPtr.Zero);
    }

    public void SetHotkey(HotkeySpec hotkey)
    {
        lock (_gate)
        {
            if (hotkey == _hotkey) return;
            _hotkey = hotkey;
        }
        PostMessageW(_hwnd, WmHotkeyChanged, IntPtr.Zero, IntPtr.Zero);
    }

    public void Show() => PostMessageW(_hwnd, WmShow, IntPtr.Zero, IntPtr.Zero);

    // ── Window thread ─────────────────────────────────────────────────────

    private void Run()
    {
        try
        {
            _threadId = GetCurrentThreadId();
            SetThreadDpiAwarenessContext(DpiAwarenessPerMonitorV2);
            CreateWindows();
            Status = GameApi.Ok;
        }
        catch (Exception error)
        {
            Status = $"could not create the window: {error.Message}";
            _created.Set();
            return;
        }
        _created.Set();

        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg); // turns dead keys / AltGr into the right characters
            DispatchMessageW(ref msg);
        }
    }

    private void CreateWindows()
    {
        var instance = GetModuleHandleW(null);
        s_windowProc = WindowProc;
        var windowClass = new WndClassEx
        {
            cbSize = (uint)Marshal.SizeOf<WndClassEx>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(s_windowProc),
            hInstance = instance,
            hCursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512)), // IDC_ARROW
            hbrBackground = GetSysColorBrush(COLOR_WINDOW),
            lpszClassName = ClassName,
        };
        RegisterClassExW(ref windowClass); // fails harmlessly if already registered (plugin reload)

        _hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, ClassName, "Lilith AI", WS_POPUP | WS_BORDER, 0, 0, 420, 80, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero) throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()})");
        _scale = Math.Max(1f, GetDpiForWindow(_hwnd) / 96f);

        _edit = CreateWindowExW(0, "EDIT", "", WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL, 0, 0, 0, 0, _hwnd, new IntPtr(IdEdit), instance, IntPtr.Zero);
        _send = CreateWindowExW(0, "BUTTON", _strings.Send, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON, 0, 0, 0, 0, _hwnd, new IntPtr(IdSend), instance, IntPtr.Zero);
        _settings = CreateWindowExW(0, "BUTTON", "⚙", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON, 0, 0, 0, 0, _hwnd, new IntPtr(IdSettings), instance, IntPtr.Zero);
        _status = CreateWindowExW(0, "STATIC", "", WS_CHILD | WS_VISIBLE | SS_ENDELLIPSIS | SS_NOPREFIX, 0, 0, 0, 0, _hwnd, IntPtr.Zero, instance, IntPtr.Zero);

        _font = CreateFontW(-(int)(15 * _scale), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
        _symbolFont = CreateFontW(-(int)(16 * _scale), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI Symbol");
        foreach (var control in new[] { _edit, _send, _status }) SendMessageW(control, WM_SETFONT, _font, new IntPtr(1));
        SendMessageW(_settings, WM_SETFONT, _symbolFont, new IntPtr(1));
        SendMessageW(_edit, EmLimitText, new IntPtr(2000), IntPtr.Zero);
        SendMessageW(_edit, EM_SETCUEBANNER, new IntPtr(1), _strings.Placeholder);

        s_editProc = EditProc;
        _originalEditProc = SetWindowLongPtr(_edit, GWLP_WNDPROC, Marshal.GetFunctionPointerForDelegate(s_editProc));
        Layout();
    }

    private void Layout()
    {
        int S(float value) => (int)(value * _scale);
        int width = S(440), margin = S(10), rowHeight = S(32), settingsWidth = S(36), sendWidth = S(84), gap = S(6);
        int editWidth = width - margin * 2 - settingsWidth - sendWidth - gap * 2;
        SetWindowPos(_edit, IntPtr.Zero, margin, margin, editWidth, rowHeight, 0x0004 /* SWP_NOZORDER */);
        SetWindowPos(_send, IntPtr.Zero, margin + editWidth + gap, margin, sendWidth, rowHeight, 0x0004);
        SetWindowPos(_settings, IntPtr.Zero, width - margin - settingsWidth, margin, settingsWidth, rowHeight, 0x0004);
        SetWindowPos(_status, IntPtr.Zero, margin, margin + rowHeight + S(6), width - margin * 2, S(22), 0x0004);
        SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, width, margin * 2 + rowHeight + S(28), 0x0002 /* SWP_NOMOVE */ | 0x0004);
    }

    private IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            switch (message)
            {
                case WM_HOTKEY:
                case WmShow:
                    if (message == WM_HOTKEY && IsWindowVisible(_hwnd)) HideAndRestoreFocus();
                    else ShowNearLilith();
                    return IntPtr.Zero;
                case WmStatus:
                    lock (_gate) SetWindowTextW(_status, _statusText);
                    return IntPtr.Zero;
                case WmStrings:
                    lock (_gate)
                    {
                        SetWindowTextW(_send, _strings.Send);
                        SendMessageW(_edit, EM_SETCUEBANNER, new IntPtr(1), _strings.Placeholder);
                    }
                    return IntPtr.Zero;
                case WmHotkeyChanged:
                    RegisterCurrentHotkey();
                    return IntPtr.Zero;
                case WM_COMMAND:
                    var id = LowWord(wParam);
                    if (id == IdSend) Submit();
                    else if (id == IdSettings) SettingsRequested?.Invoke();
                    return IntPtr.Zero;
                case WM_ACTIVATE:
                    // Clicking anywhere else closes it, like a menu.
                    if (LowWord(wParam) == WA_INACTIVE) ShowWindow(_hwnd, SW_HIDE);
                    return IntPtr.Zero;
                case WM_CLOSE:
                    ShowWindow(_hwnd, SW_HIDE);
                    return IntPtr.Zero;
                case WM_DESTROY:
                    PostQuitMessage(0);
                    return IntPtr.Zero;
            }
        }
        catch (Exception)
        {
            // Never let an exception cross into native code.
        }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }

    private IntPtr EditProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            var key = (int)(long)wParam;
            if (message == WM_KEYDOWN && key == VK_RETURN && !ImeComposing(hwnd))
            {
                Submit();
                return IntPtr.Zero;
            }
            if (message == WM_KEYDOWN && key == VK_ESCAPE)
            {
                HideAndRestoreFocus();
                return IntPtr.Zero;
            }
            // Swallow the Enter/Escape characters so the edit box doesn't beep.
            if (message == WM_CHAR && (key == '\r' || key == '\n' || key == 0x1B)) return IntPtr.Zero;
        }
        catch (Exception)
        {
            // Fall through to the default edit behavior.
        }
        return CallWindowProcW(_originalEditProc, hwnd, message, wParam, lParam);
    }

    /// <summary>While an IME is composing (Japanese, Chinese...), Enter confirms the text instead of sending.</summary>
    private static bool ImeComposing(IntPtr hwnd)
    {
        var context = ImmGetContext(hwnd);
        if (context == IntPtr.Zero) return false;
        try
        {
            return ImmGetCompositionString(context, GCS_COMPSTR, IntPtr.Zero, 0) > 0;
        }
        finally
        {
            ImmReleaseContext(hwnd, context);
        }
    }

    private void Submit()
    {
        var length = GetWindowTextLengthW(_edit);
        if (length <= 0) return;
        var buffer = new char[length + 1];
        GetWindowTextW(_edit, buffer, buffer.Length);
        var text = new string(buffer, 0, Math.Min(length, buffer.Length - 1)).Trim();
        if (text.Length == 0) return;
        SetWindowTextW(_edit, "");
        lock (_gate) SetWindowTextW(_status, _strings.Thinking);
        Submitted?.Invoke(text);
    }

    private void ShowNearLilith()
    {
        var foreground = GetForegroundWindow();
        if (foreground != _hwnd) _previousForeground = foreground;

        (int X, int Y)? anchor;
        lock (_gate) anchor = _anchor;
        int S(float value) => (int)(value * _scale);
        int width = S(440), height = S(80);
        var point = anchor is { } a ? new Point { X = a.X, Y = a.Y } : new Point { X = 0, Y = 0 };
        var info = new MonitorInfo { cbSize = (uint)Marshal.SizeOf<MonitorInfo>() };
        GetMonitorInfoW(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST), ref info);
        var work = info.rcWork;

        // Above Lilith when we know where she is; otherwise bottom-center of the screen.
        int x = anchor.HasValue ? point.X - width / 2 : (work.Left + work.Right - width) / 2;
        int y = anchor.HasValue ? point.Y - height - S(40) : work.Bottom - height - S(80);
        x = Math.Clamp(x, work.Left + S(8), Math.Max(work.Left + S(8), work.Right - width - S(8)));
        y = Math.Clamp(y, work.Top + S(8), Math.Max(work.Top + S(8), work.Bottom - height - S(8)));

        SetWindowPos(_hwnd, new IntPtr(-1) /* HWND_TOPMOST */, x, y, 0, 0, 0x0001 /* SWP_NOSIZE */);
        ShowWindow(_hwnd, SW_SHOW);
        SetForegroundWindow(_hwnd);
        SetFocus(_edit);
        SendMessageW(_edit, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
    }

    private void HideAndRestoreFocus()
    {
        ShowWindow(_hwnd, SW_HIDE);
        if (_previousForeground != IntPtr.Zero) SetForegroundWindow(_previousForeground);
    }

    private void RegisterCurrentHotkey()
    {
        HotkeySpec? hotkey;
        lock (_gate) hotkey = _hotkey;
        if (hotkey is null) return;
        UnregisterHotKey(_hwnd, HotkeyId);
        var vk = VirtualKey(hotkey.Key);
        var modifiers = MOD_NOREPEAT | (hotkey.Ctrl ? MOD_CONTROL : 0) | (hotkey.Alt ? MOD_ALT : 0) | (hotkey.Shift ? MOD_SHIFT : 0);
        var status = vk == 0
            ? $"unknown key {hotkey.Key}"
            : RegisterHotKey(_hwnd, HotkeyId, modifiers, vk)
                ? GameApi.Ok
                : $"{hotkey} is already used by another program";
        HotkeyStatusChanged?.Invoke(status);
    }

    private static uint VirtualKey(string key)
    {
        if (key.Length > 1 && key[0] == 'F' && int.TryParse(key.AsSpan(1), out var function) && function is >= 1 and <= 24)
            return (uint)(0x70 + function - 1);
        var letter = key.Length == 1 ? char.ToUpperInvariant(key[0]) : '\0';
        if (letter is >= 'A' and <= 'Z' or >= '0' and <= '9') return letter; // VK codes equal the ASCII codes
        return 0;
    }

    public void Dispose()
    {
        if (_hwnd != IntPtr.Zero)
        {
            UnregisterHotKey(_hwnd, HotkeyId);
            PostMessageW(_hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
        if (_threadId != 0) PostThreadMessageW(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        if (_font != IntPtr.Zero) DeleteObject(_font);
        if (_symbolFont != IntPtr.Zero) DeleteObject(_symbolFont);
    }
}
