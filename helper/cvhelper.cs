// cvhelper - small native helper used by ClipVault (compiled by setup.js with the
// .NET Framework C# compiler that ships with Windows, so it must stay C# 5 compatible).
//
//   cvhelper audio2 <pipePrefix> --src <name>=<kind>[:<arg>]:<volume> ...
//                   --out <name>=<src>[,<src>...] ... [--ptt <src>:<vk>:<releaseMs>]
//       Captures several sources and streams mixes of them, one per --out, as 48 kHz stereo
//       float32 through \\.\pipe\<pipePrefix>-<outName> (one pipe per audio track). Kinds:
//         loopback        everything played on the default output device
//         mic             the default microphone
//         process:<exe>   one program, including the processes it started (Windows 11)
//         except:<exe>    everything except that program (plain loopback while it isn't running)
//       Volumes are percentages. All outputs start at the same sample, so tracks stay in sync.
//       --ptt gates a source with a key or mouse button (virtual-key code, decimal or 0x..,
//       e.g. 0x05 = mouse button 4): heard while held and for releaseMs after release.
//       Prints READY once the pipes exist.
//
//   cvhelper audio <pipeName> <systemVolume|-1> <micVolume|-1> [game.exe]
//       The original single-track form: system audio (or only game.exe's sound) plus the
//       microphone, mixed into \\.\pipe\<pipeName>. -1 disables that source.
//
//   cvhelper fg
//       Prints a JSON line describing the foreground window whenever it changes.
//
//   cvhelper input [game.exe]
//       Prints a JSON line per key / mouse-button press and release, read passively with
//       Windows Raw Input (nothing is blocked or injected). With game.exe, only input made
//       while that game's window is in front is reported.
//
// All modes exit when stdin closes, so the helper never outlives the app.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ClipVault
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCo { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        void OpenPropertyStore(int access, out IntPtr properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    class WaveFormat
    {
        static readonly Guid FloatSubtype = new Guid("00000003-0000-0010-8000-00aa00389b71");
        public int Channels, Rate, BlockAlign;
        public bool IsFloat;

        public static WaveFormat Read(IntPtr p)
        {
            var f = new WaveFormat();
            int tag = (ushort)Marshal.ReadInt16(p, 0);
            f.Channels = (ushort)Marshal.ReadInt16(p, 2);
            f.Rate = Marshal.ReadInt32(p, 4);
            f.BlockAlign = (ushort)Marshal.ReadInt16(p, 12);
            if (tag == 0xFFFE)
            {
                byte[] g = new byte[16];
                Marshal.Copy(IntPtr.Add(p, 24), g, 0, 16);
                f.IsFloat = new Guid(g) == FloatSubtype;
            }
            else
            {
                f.IsFloat = tag == 3;
            }
            return f;
        }

        public override string ToString()
        {
            return Rate + " Hz, " + Channels + " ch, " + (IsFloat ? "float" : (BlockAlign / Math.Max(1, Channels) * 8) + "-bit");
        }
    }

    // Thread-safe circular buffer of interleaved stereo floats.
    class Ring
    {
        readonly float[] buf;
        int read, count;
        readonly object gate = new object();

        public Ring(int capacity) { buf = new float[capacity]; }

        public int Count { get { lock (gate) return count; } }

        public void Write(float[] src, int n)
        {
            lock (gate)
            {
                int offset = 0;
                if (n > buf.Length) { offset = n - buf.Length; n = buf.Length; }
                int overflow = count + n - buf.Length;
                if (overflow > 0) { read = (read + overflow) % buf.Length; count -= overflow; }
                int w = (read + count) % buf.Length;
                for (int i = 0; i < n; i++)
                {
                    buf[w] = src[offset + i];
                    if (++w == buf.Length) w = 0;
                }
                count += n;
            }
        }

        public int Read(float[] dst, int n)
        {
            lock (gate)
            {
                int m = Math.Min(n, count);
                for (int i = 0; i < m; i++)
                {
                    dst[i] = buf[read];
                    if (++read == buf.Length) read = 0;
                }
                count -= m;
                return m;
            }
        }

        public void Drop(int n)
        {
            lock (gate)
            {
                n = Math.Min(n, count);
                read = (read + n) % buf.Length;
                count -= n;
            }
        }
    }

    // Converts any WASAPI mix format into 48 kHz interleaved stereo float.
    class Converter
    {
        const int OutRate = 48000;
        readonly WaveFormat fmt;
        readonly int stride;
        readonly double step;
        double pos;
        float prevL, prevR;
        float[] stereo = new float[0];
        float[] output = new float[0];

        public Converter(WaveFormat f)
        {
            fmt = f;
            stride = f.BlockAlign / Math.Max(1, f.Channels);
            step = (double)f.Rate / OutRate;
        }

        float Sample(byte[] raw, int at)
        {
            if (fmt.IsFloat) return BitConverter.ToSingle(raw, at);
            switch (stride)
            {
                case 2: return BitConverter.ToInt16(raw, at) / 32768f;
                case 3: return (((raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16)) << 8) >> 8) / 8388608f;
                case 4: return BitConverter.ToInt32(raw, at) / 2147483648f;
                default: return 0f;
            }
        }

        public void Push(byte[] raw, int frames, Ring ring, bool silent)
        {
            if (stereo.Length < frames * 2) stereo = new float[frames * 2];
            if (silent)
            {
                Array.Clear(stereo, 0, frames * 2);
            }
            else
            {
                int ch = fmt.Channels;
                for (int i = 0; i < frames; i++)
                {
                    int at = i * fmt.BlockAlign;
                    float l = Sample(raw, at);
                    float r = ch > 1 ? Sample(raw, at + stride) : l;
                    if (ch >= 6)
                    {
                        // 5.1 / 7.1: fold the centre channel in so dialogue isn't lost.
                        float c = Sample(raw, at + 2 * stride) * 0.707f;
                        l += c;
                        r += c;
                    }
                    stereo[2 * i] = l;
                    stereo[2 * i + 1] = r;
                }
            }

            if (fmt.Rate == OutRate)
            {
                ring.Write(stereo, frames * 2);
                return;
            }

            // Streaming linear resampler; index -1 refers to the last frame of the previous chunk.
            int maxOut = (int)(frames / step) + 4;
            if (output.Length < maxOut * 2) output = new float[maxOut * 2];
            int n = 0;
            while (pos < frames - 1 && n < maxOut)
            {
                int i = (int)Math.Floor(pos);
                float frac = (float)(pos - i);
                float l0 = i < 0 ? prevL : stereo[2 * i], r0 = i < 0 ? prevR : stereo[2 * i + 1];
                float l1 = stereo[2 * (i + 1)], r1 = stereo[2 * (i + 1) + 1];
                output[2 * n] = l0 + (l1 - l0) * frac;
                output[2 * n + 1] = r0 + (r1 - r0) * frac;
                n++;
                pos += step;
            }
            pos -= frames;
            prevL = stereo[2 * (frames - 1)];
            prevR = stereo[2 * (frames - 1) + 1];
            ring.Write(output, n * 2);
        }
    }

    // Per-process audio capture (Windows 10 2004+ / Windows 11): ActivateAudioInterfaceAsync on the
    // virtual "process loopback" device returns an IAudioClient that hears one program only.
    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // Marker interface: the completion handler must be agile or activation fails with
    // E_ILLEGAL_METHOD_CALL, and .NET doesn't advertise agility on its own.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
    }

    static class ProcessAudio
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid,
            IntPtr activationParams, IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        // excludeTree = false: only that process tree; true: everything except it.
        public static IAudioClient Activate(int pid, bool excludeTree)
        {
            IntPtr act = Marshal.AllocHGlobal(12);
            IntPtr prop = Marshal.AllocHGlobal(24);
            try
            {
                // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, pid, INCLUDE / EXCLUDE_TARGET_PROCESS_TREE }
                Marshal.WriteInt32(act, 0, 1);
                Marshal.WriteInt32(act, 4, pid);
                Marshal.WriteInt32(act, 8, excludeTree ? 1 : 0);
                // PROPVARIANT { VT_BLOB, cbSize = 12, pBlobData = act }
                for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(prop, i, 0);
                Marshal.WriteInt16(prop, 0, 65);
                Marshal.WriteInt32(prop, 8, 12);
                Marshal.WriteIntPtr(prop, IntPtr.Size == 8 ? 16 : 12, act);
                var handler = new ActivationHandler();
                Guid iid = typeof(IAudioClient).GUID;
                IActivateAudioInterfaceAsyncOperation op;
                ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, prop, handler, out op);
                if (!handler.Done.WaitOne(5000)) throw new TimeoutException("process audio activation timed out");
                int hr;
                object client;
                op.GetActivateResult(out hr, out client);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                return (IAudioClient)client;
            }
            finally
            {
                Marshal.FreeHGlobal(prop);
                Marshal.FreeHGlobal(act);
            }
        }
    }

    // Finds a program's processes by exe name with a Toolhelp snapshot, which needs no access to
    // the processes themselves (anti-cheat protected games included).
    static class ProcessTree
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32W
        {
            public int dwSize;
            public int cntUsage;
            public int th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public int th32ModuleID;
            public int cntThreads;
            public int th32ParentProcessID;
            public int pcPriClassBase;
            public int dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateToolhelp32Snapshot(int flags, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        // pid -> parent pid of every running process named exeFile.
        static Dictionary<int, int> Find(string exeFile)
        {
            var found = new Dictionary<int, int>();
            IntPtr snap = CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
            if (snap == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var e = new PROCESSENTRY32W();
                e.dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32W));
                for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
                {
                    if (string.Equals(e.szExeFile, exeFile, StringComparison.OrdinalIgnoreCase))
                        found[e.th32ProcessID] = e.th32ParentProcessID;
                }
            }
            finally { CloseHandle(snap); }
            return found;
        }

        // Multi-process apps (Discord, browsers) run many processes with the same name; the root
        // one, whose parent isn't the same program, is the one to capture, because process
        // loopback includes everything it started. 0 = not running.
        public static int FindRoot(string exeFile)
        {
            var found = Find(exeFile);
            int best = 0, bestChildren = -1;
            foreach (var p in found)
            {
                if (p.Value != p.Key && found.ContainsKey(p.Value)) continue;
                int children = 0;
                foreach (var q in found) if (q.Value == p.Key) children++;
                if (children > bestChildren) { best = p.Key; bestChildren = children; }
            }
            if (best == 0) foreach (var p in found) { best = p.Key; break; } // parent pids form a loop (pid reuse)
            return best;
        }

        public static bool IsRunning(int pid, string exeFile)
        {
            return Find(exeFile).ContainsKey(pid);
        }
    }

    enum SourceKind { Loopback, Mic, Process, Except }

    class CaptureSource
    {
        const int PrefillFloats = 48000 * 2 * 30 / 1000;   // wait for 30 ms before (re)starting a source
        const int TargetFloats = 48000 * 2 * 40 / 1000;
        const int MaxFloats = 48000 * 2 * 150 / 1000;      // clock drift guard
        const float FadeStep = 1f / (48000 * 10 / 1000);   // push-to-talk opens / closes over 10 ms

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vk);

        // Polled rather than hooked: works the same for keyboard keys and mouse buttons.
        // Replaceable so tests can drive push-to-talk without pressing anything.
        internal static Func<int, bool> KeyDown = vk => (GetAsyncKeyState(vk) & 0x8000) != 0;

        public readonly string Label;
        public int PttKey;          // virtual-key code that gates this source; 0 = always on
        public int PttReleaseMs;    // stays open this long after the key is released
        readonly Ring ring = new Ring(48000 * 2 * 2);
        readonly SourceKind kind;
        readonly string exeFile;    // Process / Except: the program, e.g. "Discord.exe"
        readonly float gain;
        bool primed, pttUsed, waitingLogged;
        long pttLastHeld;
        float gate;
        string lastError;
        volatile bool running;

        public CaptureSource(string label, SourceKind kind, string exe, float gain)
        {
            Label = label;
            this.kind = kind;
            this.gain = gain;
            if (!string.IsNullOrEmpty(exe))
                exeFile = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe : exe + ".exe";
            if ((kind == SourceKind.Process || kind == SourceKind.Except) && exeFile == null)
                throw new ArgumentException(label + ": a program (exe name) is required");
        }

        public void Start()
        {
            running = true;
            var t = new Thread(Run);
            t.IsBackground = true;
            t.Start();
        }

        // Mixer thread: the next `frames` stereo frames, with volume and push-to-talk applied.
        // False = the source adds nothing to this block (no data yet, or the gate is shut).
        public bool Read(float[] dst, int frames, long nowMs)
        {
            int floats = frames * 2;
            int got = 0;
            int avail = ring.Count;
            if (!primed && avail >= PrefillFloats) primed = true;
            if (primed)
            {
                if (avail > MaxFloats) ring.Drop(avail - TargetFloats);
                got = ring.Read(dst, floats);
                if (got < floats) primed = false;
            }
            if (got < floats) Array.Clear(dst, got, floats - got);
            bool open = ApplyGain(dst, frames, nowMs);
            return got > 0 && open;
        }

        internal bool ApplyGain(float[] buf, int frames, long nowMs)
        {
            if (PttKey == 0)
            {
                if (gain != 1f) for (int i = 0; i < frames * 2; i++) buf[i] *= gain;
                return true;
            }
            if (KeyDown(PttKey)) { pttUsed = true; pttLastHeld = nowMs; }
            bool open = pttUsed && nowMs - pttLastHeld <= PttReleaseMs;
            if (!open && gate <= 0f) return false; // shut: exact silence
            for (int i = 0; i < frames; i++)
            {
                // Short fades instead of switching hard, which would click.
                if (open) { if (gate < 1f) gate = Math.Min(1f, gate + FadeStep); }
                else if (gate > 0f) gate = Math.Max(0f, gate - FadeStep);
                float k = gain * gate;
                buf[2 * i] *= k;
                buf[2 * i + 1] *= k;
            }
            return true;
        }

        void Run()
        {
            // Retry forever: a program that starts later, unplugged headphones or a new default
            // device all recover on their own (silence meanwhile).
            while (running)
            {
                try
                {
                    if (kind == SourceKind.Process || kind == SourceKind.Except) CaptureProcess();
                    else CaptureDevice(kind == SourceKind.Loopback, null);
                }
                catch (Exception e)
                {
                    // Logged once rather than on every retry (no microphone at all, say).
                    if (e.Message != lastError) Program.Log(Label + " capture error: " + e.Message + " (retrying)");
                    lastError = e.Message;
                    Thread.Sleep(1500);
                }
            }
        }

        // One program's sound (or everything but it) via process loopback.
        void CaptureProcess()
        {
            bool exclude = kind == SourceKind.Except;
            int pid = ProcessTree.FindRoot(exeFile);
            if (pid == 0)
            {
                if (!waitingLogged) Program.Log(Label + ": " + exeFile + " isn't running" + (exclude ? ", capturing everything" : " (silence until it starts)"));
                waitingLogged = true;
                // Nothing to leave out: plain loopback until the program starts.
                if (exclude) CaptureDevice(true, () => ProcessTree.FindRoot(exeFile) == 0);
                else Thread.Sleep(1000);
                return;
            }
            waitingLogged = false;
            IAudioClient client = ProcessAudio.Activate(pid, exclude);
            IAudioCaptureClient capture = null;
            IntPtr fmtPtr = Marshal.AllocHGlobal(18);
            var ready = new AutoResetEvent(false);
            try
            {
                // Ask for 48 kHz stereo float; AUTOCONVERTPCM converts whatever the game renders.
                Marshal.WriteInt16(fmtPtr, 0, 3);
                Marshal.WriteInt16(fmtPtr, 2, 2);
                Marshal.WriteInt32(fmtPtr, 4, 48000);
                Marshal.WriteInt32(fmtPtr, 8, 48000 * 8);
                Marshal.WriteInt16(fmtPtr, 12, 8);
                Marshal.WriteInt16(fmtPtr, 14, 32);
                Marshal.WriteInt16(fmtPtr, 16, 0);
                const int LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, SRC_DEFAULT_QUALITY = 0x08000000;
                const int AUTOCONVERTPCM = unchecked((int)0x80000000);
                client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 2000000, 0, fmtPtr, IntPtr.Zero);
                client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
                Guid iidCapture = typeof(IAudioCaptureClient).GUID;
                object c;
                client.GetService(ref iidCapture, out c);
                capture = (IAudioCaptureClient)c;
                var fmt = new WaveFormat { Channels = 2, Rate = 48000, BlockAlign = 8, IsFloat = true };
                client.Start();
                lastError = null;
                Program.Log(Label + (exclude ? " capturing everything except " : " capturing ") + exeFile + " (pid " + pid + ")");
                Pump(capture, fmt, () => ProcessTree.IsRunning(pid, exeFile));
                Program.Log(Label + ": " + exeFile + " (pid " + pid + ") closed");
            }
            finally
            {
                try { client.Stop(); } catch { }
                if (capture != null) Marshal.ReleaseComObject(capture);
                Marshal.ReleaseComObject(client);
                Marshal.FreeHGlobal(fmtPtr);
                ready.Close();
            }
        }

        // The default output (loopback) or input device. Returns when the default device changes
        // or stillWanted() turns false, so Run starts over with the new situation.
        void CaptureDevice(bool loopback, Func<bool> stillWanted)
        {
            int flow = loopback ? 0 : 1;
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
            IMMDevice device = null;
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            try
            {
                enumerator.GetDefaultAudioEndpoint(flow, 0, out device);
                string id;
                device.GetId(out id);
                Guid iidClient = typeof(IAudioClient).GUID;
                object o;
                device.Activate(ref iidClient, 23, IntPtr.Zero, out o);
                client = (IAudioClient)o;

                IntPtr fmtPtr;
                client.GetMixFormat(out fmtPtr);
                var fmt = WaveFormat.Read(fmtPtr);
                try { client.Initialize(0, loopback ? 0x00020000 : 0, 2000000, 0, fmtPtr, IntPtr.Zero); }
                finally { Marshal.FreeCoTaskMem(fmtPtr); }

                Guid iidCapture = typeof(IAudioCaptureClient).GUID;
                object c;
                client.GetService(ref iidCapture, out c);
                capture = (IAudioCaptureClient)c;

                client.Start();
                lastError = null;
                Program.Log(Label + " capturing: " + fmt);
                bool moved = false;
                Pump(capture, fmt, () =>
                {
                    if (DefaultDeviceId(enumerator, flow) != id) { moved = true; return false; }
                    return stillWanted == null || stillWanted();
                });
                if (moved) Program.Log(Label + ": default device changed");
            }
            finally
            {
                if (client != null) { try { client.Stop(); } catch { } }
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }

        static string DefaultDeviceId(IMMDeviceEnumerator enumerator, int flow)
        {
            IMMDevice d;
            enumerator.GetDefaultAudioEndpoint(flow, 0, out d);
            try
            {
                string id;
                d.GetId(out id);
                return id;
            }
            finally { Marshal.ReleaseComObject(d); }
        }

        // Drain the capture client into the ring until stopped (or keepGoing says to start over).
        void Pump(IAudioCaptureClient capture, WaveFormat fmt, Func<bool> keepGoing)
        {
            var conv = new Converter(fmt);
            byte[] raw = new byte[0];
            var sinceCheck = Stopwatch.StartNew();
            while (running)
            {
                Thread.Sleep(4);
                if (keepGoing != null && sinceCheck.ElapsedMilliseconds > 1000)
                {
                    sinceCheck.Restart();
                    if (!keepGoing()) return;
                }
                uint packet;
                int hr = capture.GetNextPacketSize(out packet);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                while (packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    long devPos, qpcPos;
                    hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                    int bytes = (int)frames * fmt.BlockAlign;
                    bool silent = (flags & 2) != 0;
                    if (!silent)
                    {
                        if (raw.Length < bytes) raw = new byte[bytes];
                        Marshal.Copy(data, raw, 0, bytes);
                    }
                    if (frames > 0) conv.Push(raw, (int)frames, ring, silent);
                    capture.ReleaseBuffer(frames);
                    hr = capture.GetNextPacketSize(out packet);
                    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                }
            }
        }
    }

    // One audio track: a pipe FFmpeg reads 48 kHz stereo float32 from. Blocks wait in a queue
    // until FFmpeg connects, so every track starts at the same sample even though FFmpeg opens
    // (and probes) its inputs one after another.
    class AudioOutput
    {
        const long MaxQueuedBytes = 48000L * 8 * 30; // FFmpeg connects within moments; cap at 30 s

        public readonly string Name;
        public readonly int[] Sources;
        readonly NamedPipeServerStream pipe;
        readonly Queue<byte[]> queue = new Queue<byte[]>();
        long queued;

        public AudioOutput(string name, string pipeName, int[] sources)
        {
            Name = name;
            Sources = sources;
            pipe = new NamedPipeServerStream(pipeName, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 1 << 20);
        }

        public void Enqueue(byte[] block)
        {
            lock (queue)
            {
                queue.Enqueue(block);
                queued += block.Length;
                while (queued > MaxQueuedBytes) queued -= queue.Dequeue().Length;
                Monitor.Pulse(queue);
            }
        }

        // Writer thread: waits for FFmpeg, then forwards blocks as they come. Returns once FFmpeg
        // has closed the pipe.
        public void Run(Action connected)
        {
            pipe.WaitForConnection();
            connected();
            try
            {
                while (true)
                {
                    byte[] block;
                    lock (queue)
                    {
                        while (queue.Count == 0) Monitor.Wait(queue);
                        block = queue.Dequeue();
                        queued -= block.Length;
                    }
                    pipe.Write(block, 0, block.Length);
                }
            }
            catch (IOException) { }
        }
    }

    // Builds every output's next block from the same source blocks. Output is paced by the wall
    // clock so the streams stay continuous (and in sync with video) even when nothing is playing
    // and WASAPI delivers no packets.
    class AudioMixer
    {
        const int Rate = 48000;
        readonly CaptureSource[] sources;
        readonly AudioOutput[] outputs;
        int started;

        public AudioMixer(CaptureSource[] sources, AudioOutput[] outputs)
        {
            this.sources = sources;
            this.outputs = outputs;
        }

        // Called when FFmpeg connects to a pipe: the first call starts the clock, at sample 0 of
        // every output.
        public void Start()
        {
            if (Interlocked.Exchange(ref started, 1) != 0) return;
            var t = new Thread(Run);
            t.IsBackground = true;
            t.Priority = ThreadPriority.AboveNormal;
            t.Start();
        }

        void Run()
        {
            var sw = Stopwatch.StartNew();
            long written = 0;
            var blocks = new float[sources.Length][];
            var active = new bool[sources.Length];
            for (int s = 0; s < sources.Length; s++) blocks[s] = new float[Rate * 2];
            float[] mix = new float[Rate * 2];
            while (true)
            {
                Thread.Sleep(5);
                long target = (long)(sw.Elapsed.TotalSeconds * Rate);
                int n = (int)Math.Min(target - written, Rate);
                if (n <= 0) continue;
                int floats = n * 2;
                long now = sw.ElapsedMilliseconds;
                for (int s = 0; s < sources.Length; s++) active[s] = sources[s].Read(blocks[s], n, now);
                foreach (var o in outputs)
                {
                    var bytes = new byte[floats * 4];
                    bool any = false;
                    Array.Clear(mix, 0, floats);
                    foreach (int s in o.Sources)
                    {
                        if (!active[s]) continue;
                        any = true;
                        float[] b = blocks[s];
                        for (int i = 0; i < floats; i++) mix[i] += b[i];
                    }
                    if (any)
                    {
                        for (int i = 0; i < floats; i++)
                        {
                            if (mix[i] > 1f) mix[i] = 1f;
                            else if (mix[i] < -1f) mix[i] = -1f;
                        }
                        Buffer.BlockCopy(mix, 0, bytes, 0, floats * 4);
                    }
                    o.Enqueue(bytes);
                }
                written += n;
            }
        }
    }

    static class Program
    {
        static readonly object logGate = new object();

        public static void Log(string msg)
        {
            lock (logGate)
            {
                Console.Error.WriteLine(msg);
                Console.Error.Flush();
            }
        }

        static void ExitWhenStdinCloses()
        {
            var t = new Thread(() =>
            {
                try
                {
                    var stdin = Console.OpenStandardInput();
                    var b = new byte[256];
                    while (stdin.Read(b, 0, b.Length) > 0) { }
                }
                catch { }
                Environment.Exit(0);
            });
            t.IsBackground = true;
            t.Start();
        }

        const string Usage = "usage: cvhelper audio2 <pipePrefix> --src <name>=<loopback|mic|process:<exe>|except:<exe>>:<volume> ... " +
            "--out <name>=<src>[,<src>...] ... [--ptt <src>:<vk>:<releaseMs>]  |  cvhelper audio <pipe> <systemVol|-1> <micVol|-1> [game.exe]" +
            "  |  cvhelper fg  |  cvhelper input [game.exe]";

        [MTAThread]
        static int Main(string[] args)
        {
            if (args.Length >= 2 && args[0] == "audio2") return RunAudio2(args);
            if (args.Length >= 1 && args[0] == "audio" && args.Length >= 4) return RunAudio(args[1], int.Parse(args[2]), int.Parse(args[3]), args.Length > 4 ? args[4] : null);
            if (args.Length >= 1 && args[0] == "fg") return RunForeground();
            if (args.Length >= 1 && args[0] == "input") return RunInput(args.Length > 1 ? args[1] : null);
            Console.Error.WriteLine(Usage);
            return 2;
        }

        // ---------------------------------------------------------------- input

        static int RunInput(string exeFilter)
        {
            ExitWhenStdinCloses();
            // Raw Input needs a window and a message loop; run them on an STA thread.
            Exception failure = null;
            var t = new Thread(() =>
            {
                try
                {
                    var sink = new RawInputSink(exeFilter);
                    System.Windows.Forms.Application.Run();
                    GC.KeepAlive(sink);
                }
                catch (Exception e) { failure = e; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            if (failure != null) { Log("input capture failed: " + failure.Message); return 1; }
            return 0;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

        [DllImport("user32.dll")]
        static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);

        class RawInputSink : System.Windows.Forms.NativeWindow
        {
            const int WM_INPUT = 0x00FF;
            const uint RID_INPUT = 0x10000003;
            const uint RIDEV_INPUTSINK = 0x00000100; // receive input even when not focused
            static readonly string[] MouseButtons = { "L", "R", "M", "X1", "X2" };

            readonly string exeFilter;
            readonly Stopwatch clock = Stopwatch.StartNew();
            readonly double epochStartMs;
            readonly HashSet<int> keysDown = new HashSet<int>();
            IntPtr lastForeground = IntPtr.Zero;
            bool foregroundMatches;

            public RawInputSink(string exeFilter)
            {
                this.exeFilter = exeFilter;
                epochStartMs = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                CreateHandle(new System.Windows.Forms.CreateParams()); // hidden, never shown
                var devices = new RAWINPUTDEVICE[2];
                devices[0].UsagePage = 1; devices[0].Usage = 6; devices[0].Flags = RIDEV_INPUTSINK; devices[0].Target = Handle; // keyboard
                devices[1].UsagePage = 1; devices[1].Usage = 2; devices[1].Flags = RIDEV_INPUTSINK; devices[1].Target = Handle; // mouse
                if (!RegisterRawInputDevices(devices, 2, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                Console.Out.WriteLine("READY");
                Console.Out.Flush();
            }

            bool GameInFront()
            {
                if (exeFilter == null) return true;
                IntPtr fg = GetForegroundWindow();
                if (fg != lastForeground)
                {
                    lastForeground = fg;
                    uint pid;
                    GetWindowThreadProcessId(fg, out pid);
                    string p = ProcessPath(pid);
                    foregroundMatches = p != null && string.Equals(Path.GetFileName(p), exeFilter, StringComparison.OrdinalIgnoreCase);
                    if (!foregroundMatches && keysDown.Count > 0)
                    {
                        // The game lost the front (Alt+Tab, the Windows key...): the releases of the
                        // keys held now won't be reported, so report them as released here, or a
                        // listener would think Alt is still held when you come back.
                        long t = (long)(epochStartMs + clock.Elapsed.TotalMilliseconds);
                        foreach (int vk in keysDown) Emit("{\"t\":" + t + ",\"k\":" + vk + ",\"d\":0}");
                        keysDown.Clear();
                    }
                }
                return foregroundMatches;
            }

            protected override void WndProc(ref System.Windows.Forms.Message m)
            {
                if (m.Msg == WM_INPUT) OnRawInput(m.LParam);
                base.WndProc(ref m);
            }

            void OnRawInput(IntPtr raw)
            {
                uint headerSize = (uint)(8 + 2 * IntPtr.Size); // RAWINPUTHEADER
                uint size = 0;
                GetRawInputData(raw, RID_INPUT, IntPtr.Zero, ref size, headerSize);
                if (size == 0 || size > 4096) return;
                IntPtr mem = Marshal.AllocHGlobal((int)size);
                try
                {
                    if (GetRawInputData(raw, RID_INPUT, mem, ref size, headerSize) != size) return;
                    if (!GameInFront()) return;
                    int type = Marshal.ReadInt32(mem, 0);
                    int at = (int)headerSize;
                    long t = (long)(epochStartMs + clock.Elapsed.TotalMilliseconds);
                    if (type == 1) // RAWKEYBOARD: MakeCode, Flags, Reserved, VKey, ...
                    {
                        int make = (ushort)Marshal.ReadInt16(mem, at);
                        int flags = (ushort)Marshal.ReadInt16(mem, at + 2);
                        int vk = (ushort)Marshal.ReadInt16(mem, at + 6);
                        if (vk == 0 || vk == 0xFF) return;
                        // Raw input reports both Shifts / Ctrls / Alts as one key; the scan
                        // code (Shift) or the E0 prefix flag (Ctrl, Alt) says which side.
                        bool e0 = (flags & 2) != 0;
                        if (vk == 0x10) vk = make == 0x36 ? 0xA1 : 0xA0;
                        else if (vk == 0x11) vk = e0 ? 0xA3 : 0xA2;
                        else if (vk == 0x12) vk = e0 ? 0xA5 : 0xA4;
                        bool up = (flags & 1) != 0;
                        if (up ? !keysDown.Remove(vk) : !keysDown.Add(vk)) return; // drop auto-repeat
                        Emit("{\"t\":" + t + ",\"k\":" + vk + ",\"d\":" + (up ? 0 : 1) + "}");
                    }
                    else if (type == 0) // RAWMOUSE: usFlags, (pad), usButtonFlags, usButtonData, ...
                    {
                        int buttons = (ushort)Marshal.ReadInt16(mem, at + 4);
                        for (int i = 0; i < MouseButtons.Length; i++)
                        {
                            if ((buttons & (1 << (2 * i))) != 0) Emit("{\"t\":" + t + ",\"m\":\"" + MouseButtons[i] + "\",\"d\":1}");
                            if ((buttons & (1 << (2 * i + 1))) != 0) Emit("{\"t\":" + t + ",\"m\":\"" + MouseButtons[i] + "\",\"d\":0}");
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(mem); }
            }

            static void Emit(string line)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        // ---------------------------------------------------------------- audio

        // The original single-track mode: everything (or one program) plus the microphone, mixed
        // into one pipe.
        static int RunAudio(string pipeName, int systemVolume, int micVolume, string onlyProcessExe)
        {
            var sources = new List<CaptureSource>();
            if (systemVolume >= 0)
            {
                sources.Add(onlyProcessExe != null
                    ? new CaptureSource("game", SourceKind.Process, onlyProcessExe, systemVolume / 100f)
                    : new CaptureSource("system", SourceKind.Loopback, null, systemVolume / 100f));
            }
            if (micVolume >= 0) sources.Add(new CaptureSource("mic", SourceKind.Mic, null, micVolume / 100f));
            var all = new int[sources.Count];
            for (int i = 0; i < all.Length; i++) all[i] = i;
            return RunAudioEngine(sources, new List<AudioOutput> { new AudioOutput("mix", pipeName, all) });
        }

        static int RunAudio2(string[] args)
        {
            string prefix = args[1];
            var sources = new List<CaptureSource>();
            var outputs = new List<AudioOutput>();
            try
            {
                var srcSpecs = new List<string>();
                var outSpecs = new List<string>();
                var pttSpecs = new List<string>();
                for (int i = 2; i < args.Length; i += 2)
                {
                    if (i + 1 >= args.Length) throw new ArgumentException(args[i] + " needs a value");
                    if (args[i] == "--src") srcSpecs.Add(args[i + 1]);
                    else if (args[i] == "--out") outSpecs.Add(args[i + 1]);
                    else if (args[i] == "--ptt") pttSpecs.Add(args[i + 1]);
                    else throw new ArgumentException("unknown option " + args[i]);
                }
                var index = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (string spec in srcSpecs)
                {
                    CaptureSource s = ParseSource(spec);
                    if (index.ContainsKey(s.Label)) throw new ArgumentException("duplicate source " + s.Label);
                    index[s.Label] = sources.Count;
                    sources.Add(s);
                }
                foreach (string spec in pttSpecs)
                {
                    // <src>:<vk>[:<releaseMs>]
                    string[] p = spec.Split(':');
                    if (p.Length < 2 || !index.ContainsKey(p[0])) throw new ArgumentException("bad --ptt " + spec);
                    CaptureSource s = sources[index[p[0]]];
                    s.PttKey = ParseInt(p[1]);
                    s.PttReleaseMs = p.Length > 2 ? ParseInt(p[2]) : 0;
                    if (s.PttKey <= 0 || s.PttKey > 255 || s.PttReleaseMs < 0) throw new ArgumentException("bad --ptt " + spec);
                }
                var outNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string spec in outSpecs)
                {
                    // <name>=<src>[,<src>...]
                    int eq = spec.IndexOf('=');
                    string name = eq > 0 ? spec.Substring(0, eq) : "";
                    if (name.Length == 0 || name.IndexOf('\\') >= 0 || !outNames.Add(name)) throw new ArgumentException("bad --out " + spec);
                    var ids = new List<int>();
                    foreach (string src in spec.Substring(eq + 1).Split(','))
                    {
                        if (src.Length == 0) continue;
                        if (!index.ContainsKey(src)) throw new ArgumentException("--out " + name + ": unknown source " + src);
                        ids.Add(index[src]);
                    }
                    outputs.Add(new AudioOutput(name, prefix + "-" + name, ids.ToArray()));
                }
                if (outputs.Count == 0) throw new ArgumentException("no --out given");
            }
            catch (Exception e)
            {
                Log("audio2: " + e.Message);
                Log(Usage);
                return 2;
            }
            return RunAudioEngine(sources, outputs);
        }

        // <name>=<kind>[:<arg>]:<volume>, e.g. "game=process:League of Legends.exe:100".
        // Exe names can't contain ':', so the volume is whatever follows the last one.
        static CaptureSource ParseSource(string spec)
        {
            int eq = spec.IndexOf('=');
            if (eq <= 0) throw new ArgumentException("bad --src " + spec);
            string name = spec.Substring(0, eq);
            string rest = spec.Substring(eq + 1);
            float gain = 1f;
            double volume;
            int last = rest.LastIndexOf(':');
            if (last > 0 && double.TryParse(rest.Substring(last + 1), NumberStyles.Float, CultureInfo.InvariantCulture, out volume))
            {
                gain = (float)(Math.Max(0, volume) / 100);
                rest = rest.Substring(0, last);
            }
            int colon = rest.IndexOf(':');
            string kind = (colon < 0 ? rest : rest.Substring(0, colon)).ToLowerInvariant();
            string arg = colon < 0 ? null : rest.Substring(colon + 1);
            switch (kind)
            {
                case "loopback": return new CaptureSource(name, SourceKind.Loopback, null, gain);
                case "mic": return new CaptureSource(name, SourceKind.Mic, null, gain);
                case "process": return new CaptureSource(name, SourceKind.Process, arg, gain);
                case "except": return new CaptureSource(name, SourceKind.Except, arg, gain);
            }
            throw new ArgumentException("unknown source kind in " + spec);
        }

        static int ParseInt(string s)
        {
            s = s.Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return Convert.ToInt32(s.Substring(2), 16);
            return int.Parse(s, CultureInfo.InvariantCulture);
        }

        static int RunAudioEngine(List<CaptureSource> sources, List<AudioOutput> outputs)
        {
            ExitWhenStdinCloses();
            var mixer = new AudioMixer(sources.ToArray(), outputs.ToArray());
            foreach (var s in sources) s.Start(); // devices warm up while FFmpeg starts
            Console.Out.WriteLine("READY");
            Console.Out.Flush();
            var closed = new ManualResetEvent(false);
            foreach (var o in outputs)
            {
                var output = o;
                var t = new Thread(() =>
                {
                    try { output.Run(mixer.Start); }
                    catch (Exception e) { Log(output.Name + " pipe: " + e.Message); }
                    closed.Set();
                });
                t.IsBackground = true;
                t.Start();
            }
            closed.WaitOne(); // FFmpeg closed a pipe: it has stopped
            return 0;
        }

        // ----------------------------------------------------------- foreground

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder sb, ref int size);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        static int RunForeground()
        {
            ExitWhenStdinCloses();
            SetProcessDPIAware();
            string last = null;
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            while (true)
            {
                string line;
                try { line = DescribeForeground(names); }
                catch (Exception e) { line = "{\"error\":" + Json(e.Message) + "}"; }
                if (line != last)
                {
                    Console.Out.WriteLine(line);
                    Console.Out.Flush();
                    last = line;
                }
                Thread.Sleep(1000);
            }
        }

        static string ProcessPath(uint pid)
        {
            IntPtr h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null;
            }
            finally { CloseHandle(h); }
        }

        static string DescribeForeground(Dictionary<string, string> names)
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return "{}";
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            var title = new StringBuilder(512);
            GetWindowText(hwnd, title, title.Capacity);
            var cls = new StringBuilder(256);
            GetClassName(hwnd, cls, cls.Capacity);

            string path = ProcessPath(pid);
            string exe = path != null ? Path.GetFileName(path) : "";
            string name = "";
            if (path != null && !names.TryGetValue(path, out name))
            {
                name = "";
                try
                {
                    var vi = FileVersionInfo.GetVersionInfo(path);
                    name = (vi.FileDescription ?? "").Trim();
                    if (name.Length == 0) name = (vi.ProductName ?? "").Trim();
                }
                catch { }
                names[path] = name;
            }

            RECT r;
            GetWindowRect(hwnd, out r);
            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref mi);
            string c = cls.ToString();
            bool fullscreen = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top &&
                              r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom &&
                              c != "Progman" && c != "WorkerW";

            return "{\"pid\":" + pid +
                   ",\"exe\":" + Json(exe) +
                   ",\"name\":" + Json(name ?? "") +
                   ",\"title\":" + Json(title.ToString()) +
                   ",\"cls\":" + Json(c) +
                   ",\"fullscreen\":" + (fullscreen ? "true" : "false") + "}";
        }

        static string Json(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }
}
