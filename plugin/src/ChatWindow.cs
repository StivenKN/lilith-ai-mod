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
/// Styled as a dark frosted-glass pill: Windows 11's acrylic backdrop shows through wherever we paint
/// black, so everything else (field, buttons, text) is custom-painted. Older Windows gets a solid
/// plum background with the same layout.
/// With voice on, a second hotkey (and a mic button in the field) starts and stops recording; the
/// recording happens on this thread too, since MCI devices belong to the thread that opened them.
/// Public methods are thread-safe: they post messages to the window thread.
/// </summary>
internal sealed class ChatWindow : IDisposable
{
    private const string ClassName = "LilithAICompanionChat";
    private const int HotkeyId = 1, VoiceHotkeyId = 2;
    private const int IdEdit = 1, IdSend = 2, IdSettings = 3, IdMic = 4;
    private const uint WmShow = WM_APP + 1, WmStatus = WM_APP + 2, WmHotkeyChanged = WM_APP + 3, WmStrings = WM_APP + 4, WmYieldFocus = WM_APP + 5, WmVoiceChanged = WM_APP + 6;
    /// <summary>A recording stops on its own after this long, in case the second key press never comes.</summary>
    private const uint VoiceLimitMs = 30_000;
    private const int VoiceTimerId = 1;
    private const uint EmLimitText = 0x00C5;

    // Layout in 96-DPI pixels.
    private const int WindowWidth = 440, Pad = 10, FieldHeight = 38, Gap = 8, StatusGap = 5, StatusHeight = 18, BottomPad = 8;
    private const int WindowHeight = Pad + FieldHeight + StatusGap + StatusHeight + BottomPad;

    // The dashboard's dark palette (companion/web/styles.css), so the popup feels like the same app.
    private const int Background = 0x171427, Field = 0x221D38, Line = 0x3A3358, Ink = 0xECE7F8, Muted = 0xA49CC0, Accent = 0xF06A8A, AccentPressed = 0xD9466A;
    private const string SendGlyph = "\uE724", SettingsGlyph = "\uE713", MicGlyph = "\uE720"; // Segoe MDL2 Assets: paper plane, gear, microphone

    // Delegates handed to native code must stay referenced for the window's lifetime.
    private static WndProc? s_windowProc;
    private static WndProc? s_editProc;

    private readonly object _gate = new();
    private readonly ManualResetEventSlim _created = new();
    private Thread? _thread;
    private uint _threadId;
    private readonly Microphone _microphone = new();
    private IntPtr _hwnd, _edit, _send, _settings, _mic, _status, _font, _statusFont, _iconFont, _originalEditProc, _previousForeground;
    private IntPtr _backgroundBrush, _fieldBrush, _accentBrush, _accentPressedBrush, _linePen;
    private uint _backgroundColor;
    private float _scale = 1f;
    private UiStrings _strings;
    private HotkeySpec? _hotkey;
    private HotkeySpec? _voiceHotkey;
    private bool _voiceEnabled;
    private string _statusText = "";
    private (int X, int Y)? _anchor;

    public ChatWindow(UiStrings strings) => _strings = strings;

    /// <summary>The user sent a message (raised on the window thread).</summary>
    public event Action<string>? Submitted;
    /// <summary>The settings button was pressed (raised on the window thread).</summary>
    public event Action? SettingsRequested;
    /// <summary>Hotkey registration result: "ok" or why it failed (raised on the window thread).</summary>
    public event Action<string>? HotkeyStatusChanged;
    /// <summary>Microphone hotkey: "ok", <see cref="Protocol.CapOff"/>, or why it failed (raised on the window thread).</summary>
    public event Action<string>? VoiceHotkeyStatusChanged;
    /// <summary>A finished recording, as a WAV file path (raised on the window thread).</summary>
    public event Action<string>? VoiceRecorded;
    /// <summary>The microphone couldn't record; technical reason (raised on the window thread).</summary>
    public event Action<string>? VoiceFailed;

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

    /// <summary>The microphone shortcut, or null to turn talking by voice off.</summary>
    public void SetVoice(HotkeySpec? hotkey)
    {
        lock (_gate) _voiceHotkey = hotkey;
        PostMessageW(_hwnd, WmVoiceChanged, IntPtr.Zero, IntPtr.Zero);
    }

    public void Show() => PostMessageW(_hwnd, WmShow, IntPtr.Zero, IntPtr.Zero);

    public void YieldFocus() => PostMessageW(_hwnd, WmYieldFocus, IntPtr.Zero, IntPtr.Zero);

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
        _microphone.Cancel(); // on this thread: it owns the MCI device
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
            lpszClassName = ClassName, // no background brush: WM_ERASEBKGND paints it
        };
        RegisterClassExW(ref windowClass); // fails harmlessly if already registered (plugin reload)

        _hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, ClassName, "Lilith AI", WS_POPUP | WS_CLIPCHILDREN, 0, 0, WindowWidth, WindowHeight, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero) throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()})");
        _scale = Math.Max(1f, GetDpiForWindow(_hwnd) / 96f);

        // Black is see-through on glass; without glass, paint the solid plum instead.
        var glass = TryApplyGlass(_hwnd);
        _backgroundColor = glass ? 0 : Rgb(Background);
        _backgroundBrush = glass ? GetStockObject(BLACK_BRUSH) : CreateSolidBrush(_backgroundColor);
        _fieldBrush = CreateSolidBrush(Rgb(Field));
        _accentBrush = CreateSolidBrush(Rgb(Accent));
        _accentPressedBrush = CreateSolidBrush(Rgb(AccentPressed));
        _linePen = CreatePen(PS_INSIDEFRAME, Math.Max(1, S(1)) * SmoothFactor, Rgb(Line));

        _edit = CreateWindowExW(0, "EDIT", "", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL, 0, 0, 0, 0, _hwnd, new IntPtr(IdEdit), instance, IntPtr.Zero);
        // The visible glyph is an icon; the window text stays the localized label for screen readers.
        _send = CreateWindowExW(0, "BUTTON", _strings.Send, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW, 0, 0, 0, 0, _hwnd, new IntPtr(IdSend), instance, IntPtr.Zero);
        _settings = CreateWindowExW(0, "BUTTON", _strings.Settings, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW, 0, 0, 0, 0, _hwnd, new IntPtr(IdSettings), instance, IntPtr.Zero);
        _mic = CreateWindowExW(0, "BUTTON", _strings.Talk, WS_CHILD | WS_TABSTOP | BS_OWNERDRAW, 0, 0, 0, 0, _hwnd, new IntPtr(IdMic), instance, IntPtr.Zero); // shown when voice is on
        _status = CreateWindowExW(0, "STATIC", "", WS_CHILD | WS_VISIBLE | SS_ENDELLIPSIS | SS_NOPREFIX, 0, 0, 0, 0, _hwnd, IntPtr.Zero, instance, IntPtr.Zero);

        _font = CreateFontW(-S(15), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
        _statusFont = CreateFontW(-S(12.5f), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
        _iconFont = CreateFontW(-S(14), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe MDL2 Assets");
        SendMessageW(_edit, WM_SETFONT, _font, new IntPtr(1));
        SendMessageW(_status, WM_SETFONT, _statusFont, new IntPtr(1));
        SendMessageW(_edit, EmLimitText, new IntPtr(2000), IntPtr.Zero);
        SendMessageW(_edit, EM_SETCUEBANNER, new IntPtr(1), _strings.Placeholder);

        s_editProc = EditProc;
        _originalEditProc = SetWindowLongPtr(_edit, GWLP_WNDPROC, Marshal.GetFunctionPointerForDelegate(s_editProc));
        Layout();
    }

    /// <summary>Asks DWM for a dark, rounded, acrylic window. False where the backdrop isn't supported (before Windows 11 22H2).</summary>
    private static bool TryApplyGlass(IntPtr hwnd)
    {
        int dark = 1, corners = DWMWCP_ROUND, backdrop = DWMSBT_TRANSIENTWINDOW;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corners, sizeof(int));
        if (DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, sizeof(int)) != 0) return false;
        var sheet = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 }; // backdrop behind the whole client area
        return DwmExtendFrameIntoClientArea(hwnd, ref sheet) == 0;
    }

    private int S(float value) => (int)(value * _scale);

    /// <summary>The rounded input field, in client coordinates. The send button sits to its right.</summary>
    private Rect FieldRect() => new()
    {
        Left = S(Pad),
        Top = S(Pad),
        Right = S(WindowWidth - Pad - Gap - FieldHeight),
        Bottom = S(Pad + FieldHeight),
    };

    private void Layout()
    {
        var field = FieldRect();
        int inset = S(16), button = S(30), textHeight = S(21);
        int settingsLeft = field.Right - S(4) - button;
        int micLeft = settingsLeft - S(2) - button;
        int buttonTop = field.Top + (field.Bottom - field.Top - button) / 2;
        // Borderless edit, vertically centered inside the painted field; the mic and the gear live at the field's end.
        int editRight = (_voiceEnabled ? micLeft : settingsLeft) - S(4);
        SetWindowPos(_edit, IntPtr.Zero, field.Left + inset, field.Top + (field.Bottom - field.Top - textHeight) / 2, editRight - field.Left - inset, textHeight, 0x0004 /* SWP_NOZORDER */);
        SetWindowPos(_mic, IntPtr.Zero, micLeft, buttonTop, button, button, 0x0004);
        SetWindowPos(_settings, IntPtr.Zero, settingsLeft, buttonTop, button, button, 0x0004);
        SetWindowPos(_send, IntPtr.Zero, field.Right + S(Gap), field.Top, S(FieldHeight), S(FieldHeight), 0x0004);
        SetWindowPos(_status, IntPtr.Zero, field.Left + inset, field.Bottom + S(StatusGap), S(WindowWidth) - field.Left - inset * 2, S(StatusHeight), 0x0004);
        SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, S(WindowWidth), S(WindowHeight), 0x0002 /* SWP_NOMOVE */ | 0x0004);
    }

    // ── Painting ──────────────────────────────────────────────────────────

    private const int SmoothFactor = 4;

    /// <summary>
    /// GDI shapes have jagged edges, so draw them <see cref="SmoothFactor"/>× larger off-screen and scale
    /// down with halftoning. <paramref name="draw"/> gets the off-screen DC and the scaled size.
    /// </summary>
    private static void DrawSmooth(IntPtr hdc, Rect area, IntPtr background, Action<IntPtr, int, int> draw)
    {
        int width = area.Right - area.Left, height = area.Bottom - area.Top;
        if (width <= 0 || height <= 0) return;
        var memory = CreateCompatibleDC(hdc);
        var bitmap = CreateCompatibleBitmap(hdc, width * SmoothFactor, height * SmoothFactor);
        var previous = SelectObject(memory, bitmap);
        var all = new Rect { Right = width * SmoothFactor, Bottom = height * SmoothFactor };
        FillRect(memory, ref all, background);
        draw(memory, all.Right, all.Bottom);
        SetStretchBltMode(hdc, HALFTONE);
        SetBrushOrgEx(hdc, 0, 0, IntPtr.Zero);
        StretchBlt(hdc, area.Left, area.Top, width, height, memory, 0, 0, all.Right, all.Bottom, SRCCOPY);
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
    }

    private void PaintField()
    {
        var hdc = BeginPaint(_hwnd, out var paint);
        DrawSmooth(hdc, FieldRect(), _backgroundBrush, (dc, width, height) =>
        {
            var oldBrush = SelectObject(dc, _fieldBrush);
            var oldPen = SelectObject(dc, _linePen);
            RoundRect(dc, 0, 0, width, height, height, height); // fully rounded ends
            SelectObject(dc, oldBrush);
            SelectObject(dc, oldPen);
        });
        EndPaint(_hwnd, ref paint);
    }

    private void DrawButton(DrawItemStruct item)
    {
        var pressed = (item.itemState & ODS_SELECTED) != 0;
        var hdc = item.hDC;
        var bounds = item.rcItem;
        // The send button is always an accent circle; the mic turns into one while it's recording.
        var filled = item.CtlID == IdSend || (item.CtlID == IdMic && _microphone.Recording);
        if (filled)
        {
            DrawSmooth(hdc, bounds, item.CtlID == IdSend ? _backgroundBrush : _fieldBrush, (dc, width, height) =>
            {
                var oldBrush = SelectObject(dc, pressed ? _accentPressedBrush : _accentBrush);
                var oldPen = SelectObject(dc, GetStockObject(NULL_PEN));
                Ellipse(dc, 0, 0, width + 1, height + 1); // NULL_PEN draws one pixel short
                SelectObject(dc, oldBrush);
                SelectObject(dc, oldPen);
            });
        }
        else
        {
            FillRect(hdc, ref bounds, _fieldBrush);
        }
        var oldFont = SelectObject(hdc, _iconFont);
        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, filled ? 0xFFFFFF : Rgb(pressed ? Ink : Muted));
        var glyph = item.CtlID switch { IdSend => SendGlyph, IdMic => MicGlyph, _ => SettingsGlyph };
        DrawTextW(hdc, glyph, -1, ref bounds, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        SelectObject(hdc, oldFont);
    }

    private IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            switch (message)
            {
                case WM_HOTKEY when (int)(long)wParam == VoiceHotkeyId:
                    ToggleRecording();
                    return IntPtr.Zero;
                case WM_HOTKEY:
                case WmShow:
                    if (message == WM_HOTKEY && IsWindowVisible(_hwnd)) HideAndRestoreFocus();
                    else ShowNearLilith();
                    return IntPtr.Zero;
                case WmVoiceChanged:
                    ApplyVoiceSettings();
                    return IntPtr.Zero;
                case WM_TIMER when (long)wParam == VoiceTimerId:
                    if (_microphone.Recording) StopRecording();
                    return IntPtr.Zero;
                case WmStatus:
                    lock (_gate) SetWindowTextW(_status, _statusText);
                    return IntPtr.Zero;
                case WmYieldFocus:
                    if (IsWindowVisible(_hwnd))
                    {
                        if (GetForegroundWindow() == _hwnd) HideAndRestoreFocus();
                        else ShowWindow(_hwnd, SW_HIDE);
                    }
                    return IntPtr.Zero;
                case WmStrings:
                    lock (_gate)
                    {
                        SetWindowTextW(_send, _strings.Send);
                        SetWindowTextW(_settings, _strings.Settings);
                        SetWindowTextW(_mic, _strings.Talk);
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
                    else if (id == IdMic) ToggleRecording();
                    if (id is IdSend or IdSettings or IdMic) SetFocus(_edit); // keep typing without clicking back
                    return IntPtr.Zero;
                case WM_ERASEBKGND:
                    GetClientRect(hwnd, out var client);
                    FillRect(wParam, ref client, _backgroundBrush);
                    return new IntPtr(1);
                case WM_PAINT:
                    PaintField();
                    return IntPtr.Zero;
                case WM_DRAWITEM:
                    DrawButton(Marshal.PtrToStructure<DrawItemStruct>(lParam));
                    return new IntPtr(1);
                case WM_CTLCOLOREDIT:
                    SetTextColor(wParam, Rgb(Ink));
                    SetBkColor(wParam, Rgb(Field));
                    return _fieldBrush;
                case WM_CTLCOLORSTATIC:
                    SetTextColor(wParam, Rgb(Muted));
                    SetBkColor(wParam, _backgroundColor);
                    return _backgroundBrush;
                case WM_ACTIVATE:
                    // Clicking anywhere else closes it, like a menu (but not mid-recording: it shows that she's listening).
                    if (LowWord(wParam) == WA_INACTIVE && !_microphone.Recording) ShowWindow(_hwnd, SW_HIDE);
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
                if (_microphone.Recording) CancelRecording();
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
        int width = S(WindowWidth), height = S(WindowHeight);
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
        HotkeyStatusChanged?.Invoke(Register(HotkeyId, hotkey));
    }

    /// <summary>(Re)registers a global hotkey; returns "ok" or why it failed.</summary>
    private string Register(int id, HotkeySpec hotkey)
    {
        UnregisterHotKey(_hwnd, id);
        var vk = VirtualKey(hotkey.Key);
        var modifiers = MOD_NOREPEAT | (hotkey.Ctrl ? MOD_CONTROL : 0) | (hotkey.Alt ? MOD_ALT : 0) | (hotkey.Shift ? MOD_SHIFT : 0);
        return vk == 0
            ? $"unknown key {hotkey.Key}"
            : RegisterHotKey(_hwnd, id, modifiers, vk)
                ? GameApi.Ok
                : $"{hotkey} is already used by another program";
    }

    // ── Voice ─────────────────────────────────────────────────────────────

    private void ApplyVoiceSettings()
    {
        HotkeySpec? hotkey;
        lock (_gate) hotkey = _voiceHotkey;
        _voiceEnabled = hotkey is not null;
        if (hotkey is null)
        {
            UnregisterHotKey(_hwnd, VoiceHotkeyId);
            if (_microphone.Recording) CancelRecording();
        }
        ShowWindow(_mic, _voiceEnabled ? SW_SHOW : SW_HIDE);
        Layout();
        VoiceHotkeyStatusChanged?.Invoke(hotkey is null ? Protocol.CapOff : Register(VoiceHotkeyId, hotkey));
    }

    /// <summary>First press listens (showing the popup so the player knows), second press sends.</summary>
    private void ToggleRecording()
    {
        if (_microphone.Recording)
        {
            StopRecording();
            return;
        }
        Speaker.Stop(); // don't record her own voice
        var error = _microphone.Start();
        if (error is not null)
        {
            VoiceFailed?.Invoke(error);
            return;
        }
        if (!IsWindowVisible(_hwnd)) ShowNearLilith();
        lock (_gate) SetWindowTextW(_status, _strings.Listening);
        SetTimer(_hwnd, (UIntPtr)VoiceTimerId, VoiceLimitMs, IntPtr.Zero);
        InvalidateRect(_mic, IntPtr.Zero, false);
    }

    private void StopRecording()
    {
        KillTimer(_hwnd, (UIntPtr)VoiceTimerId);
        var (path, error) = _microphone.Stop();
        InvalidateRect(_mic, IntPtr.Zero, false);
        lock (_gate) SetWindowTextW(_status, _strings.Thinking);
        if (path is not null) VoiceRecorded?.Invoke(path);
        else VoiceFailed?.Invoke(error ?? "the recording could not be saved");
    }

    private void CancelRecording()
    {
        KillTimer(_hwnd, (UIntPtr)VoiceTimerId);
        _microphone.Cancel();
        InvalidateRect(_mic, IntPtr.Zero, false);
        lock (_gate) SetWindowTextW(_status, "");
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
            UnregisterHotKey(_hwnd, VoiceHotkeyId);
            PostMessageW(_hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
        if (_threadId != 0) PostThreadMessageW(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        // Stock objects (the glass background brush) ignore DeleteObject, so everything can go the same way.
        foreach (var gdiObject in new[] { _font, _statusFont, _iconFont, _backgroundBrush, _fieldBrush, _accentBrush, _accentPressedBrush, _linePen })
            if (gdiObject != IntPtr.Zero) DeleteObject(gdiObject);
    }
}
