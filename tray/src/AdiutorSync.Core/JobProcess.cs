using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AdiutorSync.Core;

/// <summary>
/// One engine process, in the tray's Job Object and in a job of its own from the moment it exists (documented Win32:
/// CreateProcessW with STARTUPINFOEX, PROC_THREAD_ATTRIBUTE_JOB_LIST and PROC_THREAD_ATTRIBUTE_HANDLE_LIST). It inherits
/// only its three standard handles, which are inheritable just for the call. The handle CreateProcessW returned is kept
/// for the command's whole life: waiting and ending go through it and through the command's job, never through a
/// process id, which Windows may give to another process once this one has ended. Ending the command's job ends this
/// process and every child it started, and nothing else.
/// </summary>
public sealed partial class JobProcess : IDisposable
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private static readonly IntPtr AttributeHandleList = 0x00020002;
    private static readonly IntPtr AttributeJobList = 0x0002000D;
    private static readonly Lock CreateLock = new();

    private readonly SafeProcessHandle _process;
    private readonly EngineJob _job;
    private readonly RegisteredWaitHandle _registration;
    private readonly ExitHandle _exitHandle;

    private JobProcess(SafeProcessHandle process, EngineJob job, StreamWriter input, StreamReader output, StreamReader error)
    {
        _process = process;
        _job = job;
        StandardInput = input;
        StandardOutput = output;
        StandardError = error;
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _exitHandle = new ExitHandle(process);
        _registration = ThreadPool.RegisterWaitForSingleObject(_exitHandle, (_, _) => exited.TrySetResult(), null, Timeout.Infinite, executeOnlyOnce: true);
        Exited = exited.Task;
    }

    public StreamWriter StandardInput { get; }

    /** Read with overlapped I/O, so a read can be cancelled. */
    public StreamReader StandardOutput { get; }

    public StreamReader StandardError { get; }

    /** Completes when the process has ended (its own handle is signalled). */
    public Task Exited { get; }

    /**
     * Starts the program in the tray's job and a job of its own, suspended, then lets it run. Null when it could not be
     * created; whatever was created and not handed back is ended with its job. `beforeResume` is a test seam: it runs
     * while the process exists but has run no code.
     */
    public static unsafe JobProcess? Start(string program, IReadOnlyList<string> args, string workingDirectory, EngineJob trayJob, Action<int>? beforeResume = null)
    {
        var commandLine = new StringBuilder();
        AppendArgument(commandLine, program);
        foreach (var arg in args)
        {
            commandLine.Append(' ');
            AppendArgument(commandLine, arg);
        }
        commandLine.Append('\0');
        var line = commandLine.ToString().ToCharArray();

        var job = new EngineJob();
        SafeFileHandle? inChild = null, inParent = null, outParent = null, outChild = null, errParent = null, errChild = null;
        IntPtr attributes = IntPtr.Zero;
        SafeProcessHandle? process = null;
        var handedBack = false;
        var trayJobHeld = false;
        try
        {
            // The tray's job stays open during the call; once Quit closed it, nothing starts.
            try
            {
                trayJob.Handle.DangerousAddRef(ref trayJobHeld);
            }
            catch (ObjectDisposedException)
            {
                return null;
            }
            if (!CreatePipe(out inChild, out inParent, IntPtr.Zero, 0))
                return null;
            OutputPipe(out outParent, out outChild);
            OutputPipe(out errParent, out errChild);

            var handles = stackalloc IntPtr[3] { inChild.DangerousGetHandle(), outChild.DangerousGetHandle(), errChild.DangerousGetHandle() };
            var jobs = stackalloc IntPtr[2] { trayJob.Handle.DangerousGetHandle(), job.Handle.DangerousGetHandle() };
            nuint size = 0;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal((nint)size);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size) ||
                !UpdateProcThreadAttribute(attributes, 0, AttributeHandleList, (IntPtr)handles, (nuint)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero) ||
                !UpdateProcThreadAttribute(attributes, 0, AttributeJobList, (IntPtr)jobs, (nuint)(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                return null;
            var startup = new StartupInfoEx
            {
                StartupInfo = new StartupInfo
                {
                    Cb = Marshal.SizeOf<StartupInfoEx>(),
                    Flags = StartfUseStdHandles,
                    StdInput = handles[0],
                    StdOutput = handles[1],
                    StdError = handles[2],
                },
                AttributeList = attributes,
            };
            ProcessInformation info;
            bool created;
            // The child's ends are inheritable only during this call; the handle list keeps every other handle out.
            lock (CreateLock)
            {
                Inherit(true, inChild, outChild, errChild);
                fixed (char* cmd = line)
                fixed (char* cwd = workingDirectory)
                {
                    created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                        CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                        IntPtr.Zero, cwd, ref startup, out info);
                }
                Inherit(false, inChild, outChild, errChild);
            }
            if (!created)
                return null;
            process = new SafeProcessHandle(info.Process, ownsHandle: true);
            using var thread = new SafeProcessHandle(info.Thread, ownsHandle: true);
            beforeResume?.Invoke(info.ProcessId);
            if (ResumeThread(thread) == uint.MaxValue)
                return null;
            var utf8 = new UTF8Encoding(false);
            var result = new JobProcess(
                process,
                job,
                new StreamWriter(new FileStream(inParent, FileAccess.Write, 4096, false), utf8) { AutoFlush = true },
                new StreamReader(new FileStream(outParent, FileAccess.Read, 4096, true), utf8),
                new StreamReader(new FileStream(errParent, FileAccess.Read, 4096, true), utf8));
            handedBack = true;
            return result;
        }
        finally
        {
            if (trayJobHeld)
                trayJob.Handle.DangerousRelease();
            if (attributes != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            inChild?.Dispose();
            outChild?.Dispose();
            errChild?.Dispose();
            if (!handedBack)
            {
                // Closing the command's job ends a process that was created but not handed back, whatever failed.
                job.Dispose();
                process?.Dispose();
                inParent?.Dispose();
                outParent?.Dispose();
                errParent?.Dispose();
            }
        }
    }

    /** Ends the process and every child it started (its own job). */
    public void Kill() => TerminateJobObject(_job.Handle, 1);

    public void Dispose()
    {
        _registration.Unregister(null);
        StandardInput.Dispose();
        StandardOutput.Dispose();
        StandardError.Dispose();
        // A child the engine left running ends with the command's job.
        _job.Dispose();
        _exitHandle.Dispose();
        _process.Dispose();
    }

    /** One argument as the Microsoft C runtime reads a command line (the rules node.exe's argv follows). */
    internal static void AppendArgument(StringBuilder line, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0)
        {
            line.Append(arg);
            return;
        }
        line.Append('"');
        for (var i = 0; i < arg.Length; i++)
        {
            var backslashes = 0;
            while (i < arg.Length && arg[i] == '\\')
            {
                backslashes++;
                i++;
            }
            if (i == arg.Length)
            {
                line.Append('\\', backslashes * 2);
                break;
            }
            if (arg[i] == '"')
                line.Append('\\', backslashes * 2 + 1).Append('"');
            else
                line.Append('\\', backslashes).Append(arg[i]);
        }
        line.Append('"');
    }

    /** A pipe the tray reads with overlapped I/O (a named pipe of one instance, local only) and the child writes to. */
    private static void OutputPipe(out SafeFileHandle parent, out SafeFileHandle child)
    {
        var name = $@"\\.\pipe\adiutor-sync-{Environment.ProcessId}-{Guid.NewGuid():N}";
        parent = CreateNamedPipeW(name, 0x00000001 /* inbound */ | 0x40000000 /* overlapped */ | 0x00080000 /* first instance */,
            0x00000008 /* reject remote clients; byte, wait */, 1, 4096, 4096, 0, IntPtr.Zero);
        if (parent.IsInvalid)
            throw new System.ComponentModel.Win32Exception();
        child = CreateFileW(name, 0x40000000 /* write */, 0, IntPtr.Zero, 3 /* open existing */, 0x80, IntPtr.Zero);
        if (child.IsInvalid)
            throw new System.ComponentModel.Win32Exception();
    }

    private static void Inherit(bool on, params SafeFileHandle[] handles)
    {
        foreach (var handle in handles)
            SetHandleInformation(handle, HandleFlagInherit, on ? HandleFlagInherit : 0);
    }

    /** The process handle as a wait handle, without owning it. */
    private sealed class ExitHandle : WaitHandle
    {
        public ExitHandle(SafeProcessHandle process) => SafeWaitHandle = new SafeWaitHandle(process.DangerousGetHandle(), ownsHandle: false);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Cb;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, int size);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outSize, uint inSize, uint timeout, IntPtr attributes);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref nuint size);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returnSize);

    [LibraryImport("kernel32.dll")]
    private static partial void DeleteProcThreadAttributeList(IntPtr list);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool CreateProcessW(char* application, char* commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, char* currentDirectory,
        ref StartupInfoEx startup, out ProcessInformation information);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint ResumeThread(SafeProcessHandle thread);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TerminateJobObject(SafeFileHandle job, uint exitCode);
}
