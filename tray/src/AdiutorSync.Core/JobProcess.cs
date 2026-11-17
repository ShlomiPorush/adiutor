using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AdiutorSync.Core;

/// <summary>
/// A process started inside the tray's Job Object before it runs any code (documented Win32: CreateProcessW with
/// CREATE_SUSPENDED, AssignProcessToJobObject, then ResumeThread). .NET's Process cannot start a process suspended, so
/// the standard streams are anonymous pipes made here, as Process makes them: the child's ends are inheritable only
/// while the process is created, under one lock, so a second engine started at the same time never holds them.
/// </summary>
public sealed partial class JobProcess : IDisposable
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private static readonly Lock CreateLock = new();

    private JobProcess(Process process, StreamWriter input, StreamReader output, StreamReader error)
    {
        Process = process;
        StandardInput = input;
        StandardOutput = output;
        StandardError = error;
    }

    public Process Process { get; }
    public StreamWriter StandardInput { get; }
    public StreamReader StandardOutput { get; }
    public StreamReader StandardError { get; }

    /**
     * Starts the program suspended, puts it in the job and only then lets it run. Null when Windows refuses to create
     * it or to put it in the job (the process is then ended before it ran). `beforeResume` is a test seam: it runs while
     * the process exists but has run nothing.
     */
    public static unsafe JobProcess? Start(string program, IReadOnlyList<string> args, string workingDirectory, EngineJob job, Action<int>? beforeResume = null)
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

        SafeFileHandle? inRead = null, inWrite = null, outRead = null, outWrite = null, errRead = null, errWrite = null;
        ProcessInformation info;
        lock (CreateLock)
        {
            try
            {
                Pipe(out inRead, out inWrite, parentReads: false);
                Pipe(out outRead, out outWrite, parentReads: true);
                Pipe(out errRead, out errWrite, parentReads: true);
                var startup = new StartupInfo
                {
                    Cb = Marshal.SizeOf<StartupInfo>(),
                    Flags = StartfUseStdHandles,
                    StdInput = inRead.DangerousGetHandle(),
                    StdOutput = outWrite.DangerousGetHandle(),
                    StdError = errWrite.DangerousGetHandle(),
                };
                bool created;
                fixed (char* cmd = line)
                fixed (char* cwd = workingDirectory)
                {
                    created = CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                        CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment, IntPtr.Zero, cwd, ref startup, out info);
                }
                if (!created)
                {
                    DisposeAll(inWrite, outRead, errRead);
                    return null;
                }
            }
            finally
            {
                // The child's ends belong to the child now (or to nobody).
                DisposeAll(inRead, outWrite, errWrite);
            }
        }

        using var processHandle = new SafeProcessHandle(info.Process, ownsHandle: true);
        using var threadHandle = new SafeProcessHandle(info.Thread, ownsHandle: true);
        beforeResume?.Invoke(info.ProcessId);
        if (!job.Assign(processHandle))
        {
            // Never let the engine run outside the job: it has run no code yet.
            TerminateProcess(processHandle, 1);
            DisposeAll(inWrite, outRead, errRead);
            return null;
        }
        // The process handle stays open until here, so the id cannot name another process yet.
        var process = Process.GetProcessById(info.ProcessId);
        if (ResumeThread(threadHandle) == uint.MaxValue)
        {
            TerminateProcess(processHandle, 1);
            process.Dispose();
            DisposeAll(inWrite, outRead, errRead);
            return null;
        }
        var utf8 = new UTF8Encoding(false);
        return new JobProcess(
            process,
            new StreamWriter(new FileStream(inWrite!, FileAccess.Write, 4096, false), utf8) { AutoFlush = true },
            new StreamReader(new FileStream(outRead!, FileAccess.Read, 4096, false), utf8),
            new StreamReader(new FileStream(errRead!, FileAccess.Read, 4096, false), utf8));
    }

    public void Kill()
    {
        try
        {
            Process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
        }
        catch (System.ComponentModel.Win32Exception)
        {
        }
    }

    public void Dispose()
    {
        StandardInput.Dispose();
        StandardOutput.Dispose();
        StandardError.Dispose();
        Process.Dispose();
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

    private static void Pipe(out SafeFileHandle read, out SafeFileHandle write, bool parentReads)
    {
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), InheritHandle = 1 };
        if (!CreatePipe(out read, out write, ref attributes, 0))
            throw new System.ComponentModel.Win32Exception();
        // The parent's end is never inherited.
        if (!SetHandleInformation(parentReads ? read : write, HandleFlagInherit, 0))
            throw new System.ComponentModel.Win32Exception();
    }

    private static void DisposeAll(params SafeFileHandle?[] handles)
    {
        foreach (var handle in handles)
            handle?.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
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
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, int size);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool CreateProcessW(char* application, char* commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, char* currentDirectory,
        ref StartupInfo startup, out ProcessInformation information);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint ResumeThread(SafeProcessHandle thread);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TerminateProcess(SafeProcessHandle process, uint exitCode);
}
